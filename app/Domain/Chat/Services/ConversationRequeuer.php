<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Actions\OfferToAgents;
use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Jobs\ExpireQueuedConversation;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Support\Database\DeadlockRetry;

/**
 * Takes an ACTIVE conversation away from its agent and puts it back in the queue (`active -> queued`): a transfer to a
 * category or to a colleague, or an agent who was deactivated. The one place that knows how (decision P4-D4):
 *
 * - one guarded `UPDATE ... WHERE status = 'active' AND assigned_agent_id = :agent` clears the assignee, restarts the queue clock
 *   (`queue_expires_at = now + the widget's queue timeout`, waves from 1) and optionally changes the category;
 * - the old offers are deleted, the agent who just let go gets a `dismissed` row so they are not offered the chat again, and
 *   offers are made again: to the target agent only (a transfer to a colleague), or by the routing waves (everything else);
 * - the event is written to `conversation_events` in the same transaction. Offline tickets are re-queued without offers
 *   (they are found by the category).
 *
 * The caller dispatches the domain events after it returns. Returns null when the conversation was no longer active with that
 * agent (somebody else moved it first).
 */
final class ConversationRequeuer
{
    public function __construct(
        private readonly OfferToAgents $offers,
        private readonly ConversationTimeline $timeline,
    ) {}

    /**
     * @param  array<string, mixed>  $payload  extra data for the timeline row
     */
    public function requeue(
        Conversation $conversation,
        ?int $fromAgentId,
        ?Category $toCategory,
        ?User $toAgent,
        string $event,
        ActorType $actorType,
        ?int $actorId,
        array $payload = [],
    ): ?Conversation {
        $moved = DeadlockRetry::transaction(function () use ($conversation, $fromAgentId, $toCategory, $toAgent, $event, $actorType, $actorId, $payload): ?Conversation {
            $locked = Conversation::query()->with('widget')->whereKey($conversation->id)->lockForUpdate()->first();

            if ($locked === null || $locked->status !== ConversationStatus::Active || $locked->assigned_agent_id !== $fromAgentId) {
                return null;
            }

            $live = $locked->type === ConversationType::Live;
            $now = now();

            Conversation::query()->whereKey($locked->id)->where('status', ConversationStatus::Active->value)->update([
                'status' => ConversationStatus::Queued->value,
                'assigned_agent_id' => null,
                'claimed_at' => null,
                'idle_expires_at' => null,
                'queued_at' => $now,
                'queue_expires_at' => $live ? $now->addSeconds(max(1, (int) $locked->widget->queue_timeout_seconds)) : null,
                'wave' => 0,
                'category_id' => $toCategory !== null ? $toCategory->id : $locked->category_id,
            ]);

            ConversationOffer::query()->where('conversation_id', $locked->id)->delete();

            $fresh = Conversation::query()->with(['widget', 'category', 'visitor', 'assignedAgent'])->findOrFail($locked->id);

            $this->timeline->record($fresh, $event, $actorType, $actorId, $payload + [
                'from_agent' => $fromAgentId,
                'to_agent' => $toAgent?->id,
                'to_category' => $toCategory?->ulid,
            ]);

            if ($live) {
                $this->offer($fresh, $fromAgentId, $toAgent);
            }

            return $fresh;
        });

        return $moved;
    }

    private function offer(Conversation $conversation, ?int $fromAgentId, ?User $toAgent): void
    {
        $now = now();

        if ($fromAgentId !== null) {
            ConversationOffer::query()->create([
                'conversation_id' => $conversation->id,
                'user_id' => $fromAgentId,
                'wave' => 0,
                'offered_at' => $now,
                'expires_at' => $now,
                'responded_at' => $now,
                'response' => OfferResponse::Dismissed,
            ]);
        }

        if ($toAgent === null) {
            $this->offers->start($conversation);

            return;
        }

        ConversationOffer::query()->create([
            'conversation_id' => $conversation->id,
            'user_id' => $toAgent->id,
            'wave' => 1,
            'offered_at' => $now,
            'expires_at' => $conversation->queue_expires_at,
        ]);
        ExpireQueuedConversation::schedule($conversation);
    }
}
