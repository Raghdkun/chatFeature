<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Services\ConversationMessenger;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Domain\Presence\AvailableAgents;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\DB;

/**
 * The first accept wins (decision P4-D5). The guarded
 * `UPDATE conversations SET status = 'active', assigned_agent_id = :agent ... WHERE id = :id AND status = 'queued' AND assigned_agent_id IS NULL`
 * is the only way a chat becomes active: one affected row = this agent won, zero = somebody else did (`409 already_claimed`).
 *
 * Before the race: the agent must be an active agent who may see the queued chat (an open offer, or an offline ticket of a
 * category they serve), must still serve its category (admins excepted) and, for a live chat, must be under `max_concurrent_chats`
 * (offline tickets take no slot). The capacity check runs inside the transaction after the agent's own row is locked, so two
 * claims of the same agent cannot both slip past it.
 * The winner's offer becomes `accepted`, the others `taken`; a live chat gets the "joined" system line.
 *
 * (A Redis `SET NX` could take load off the database; it is deliberately absent: the SQL alone is correct and needs no Redis.)
 */
final class ClaimConversation
{
    public function __construct(
        private readonly ConversationPolicy $policy,
        private readonly AvailableAgents $agents,
        private readonly ConversationMessenger $messenger,
        private readonly ConversationTimeline $timeline,
    ) {}

    public function handle(Conversation $conversation, User $actor): Conversation
    {
        $conversation = Conversation::query()->with(['widget', 'category'])->findOrFail($conversation->id);

        $this->authorize($conversation, $actor);

        /** @var array{message: Message|null, taken: list<int>}|null $result */
        $result = DeadlockRetry::transaction(function () use ($conversation, $actor): ?array {
            // Serialise one agent's claims so the capacity check below cannot be raced by their own parallel accepts.
            User::query()->whereKey($actor->id)->lockForUpdate()->first();

            // Offline tickets take no slot, so they can be picked up however busy the agent is with live chats.
            if ($conversation->type === ConversationType::Live && $this->agents->activeChats($actor->id) >= max(1, (int) $actor->max_concurrent_chats)) {
                throw ApiProblemException::conflict('at_capacity', __('You are already handling the maximum number of chats.'));
            }

            $takenBy = array_map(intval(...), ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', '!=', $actor->id)
                ->whereNull('responded_at')
                ->pluck('user_id')
                ->all());

            $now = now();
            $live = $conversation->type === ConversationType::Live;

            $claimed = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Queued->value)
                ->whereNull('assigned_agent_id')
                ->update([
                    'status' => ConversationStatus::Active->value,
                    'assigned_agent_id' => $actor->id,
                    'claimed_at' => $now,
                    'claim_version' => DB::raw('claim_version + 1'),
                    'last_activity_at' => $now,
                    'idle_expires_at' => $live ? $now->addMinutes(max(1, (int) $conversation->widget->idle_timeout_minutes)) : null,
                ]);

            if ($claimed === 0) {
                return null;
            }

            ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', $actor->id)
                ->update(['responded_at' => $now, 'response' => OfferResponse::Accepted->value]);
            ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->where('user_id', '!=', $actor->id)
                ->whereNull('responded_at')
                ->update(['responded_at' => $now, 'response' => OfferResponse::Taken->value]);

            $this->timeline->record($conversation, ConversationTimeline::CLAIMED, ActorType::Agent, $actor->id, ['wave' => $conversation->wave]);

            $joined = null;

            if ($live) {
                $locked = Conversation::query()->with('widget')->whereKey($conversation->id)->lockForUpdate()->firstOrFail();
                $joined = $this->messenger->append($locked, SenderType::System, MessageType::System, __(':name joined the chat.', ['name' => $actor->label]));
            }

            return ['message' => $joined, 'taken' => $takenBy];
        });

        if ($result === null) {
            throw $this->lost($conversation->id);
        }

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id);

        ConversationClaimed::dispatch($fresh, $actor);

        if ($result['taken'] !== []) {
            ChatTaken::dispatch($fresh, $actor, $result['taken']);
        }

        if ($result['message'] instanceof Message) {
            MessageCreated::dispatch($result['message']->load(['conversation.visitor', 'senderUser', 'attachments']));
        }

        QueueChanged::dispatch($fresh);

        return $fresh;
    }

    /**
     * Who may take this chat at all. A chat that is no longer queued is `409` for an agent who was offered it (so their client can
     * drop the offer), `403` for anyone else (who learns nothing about it).
     */
    private function authorize(Conversation $conversation, User $actor): void
    {
        if (! $actor->is_active || ! $actor->is_agent) {
            throw ApiProblemException::forbidden('forbidden', __('Only agents can accept chats.'));
        }

        if ($conversation->status !== ConversationStatus::Queued || $conversation->assigned_agent_id !== null) {
            if ($actor->is_admin || ConversationOffer::query()->where('conversation_id', $conversation->id)->where('user_id', $actor->id)->exists()) {
                throw $this->lost($conversation->id);
            }

            throw ApiProblemException::forbidden('forbidden', __('This action is not allowed.'));
        }

        if (! $this->policy->claim($actor, $conversation)) {
            throw ApiProblemException::forbidden('forbidden', __('This chat was not offered to you.'));
        }

        if (! $actor->is_admin && $conversation->category_id !== null && ! $actor->categories()->whereKey($conversation->category_id)->exists()) {
            throw ApiProblemException::forbidden('forbidden', __('You do not serve this topic.'));
        }
    }

    private function lost(int $conversationId): ApiProblemException
    {
        $current = Conversation::query()->with('assignedAgent')->find($conversationId);

        if ($current === null || $current->assignedAgent === null) {
            return ApiProblemException::conflict('conversation_not_queued', __('This chat is no longer waiting for an agent.'));
        }

        // `details.by` is the winner's name (docs/contracts/realtime-events.md), a plain string rather than a list of messages.
        return new ApiProblemException(409, 'already_claimed', __('Another agent already accepted this chat.'), ['by' => $current->assignedAgent->label]);
    }
}
