<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Support\Facades\DB;

/**
 * Staff close a conversation without a rating prompt (`POST /conversations/{ulid}/close`): result `closed`, reason `system`.
 * An agent resolves their own claimed OFFLINE ticket this way (live chats are ended, not closed); an admin may close any
 * conversation that is not finished yet, including a queued one (dismiss) or one waiting for its rating. Authorisation is the
 * policy's `close` rule, called directly; the guarded `UPDATE ... WHERE status = :seen` makes a concurrent change a `409`.
 */
final class CloseConversation
{
    public function __construct(
        private readonly ConversationPolicy $policy,
        private readonly ConversationTimeline $timeline,
    ) {}

    public function handle(Conversation $conversation, User $actor): Conversation
    {
        $conversation = Conversation::query()->findOrFail($conversation->id);
        $from = $conversation->status;

        if (! $this->policy->close($actor, $conversation)) {
            if ($from->isTerminal()) {
                throw ApiProblemException::conflict('conversation_not_open', __('This conversation is already closed.'));
            }

            throw ApiProblemException::forbidden('forbidden', __('This action is not allowed.'));
        }

        if (! $actor->is_admin && $conversation->type !== ConversationType::Offline) {
            throw ApiProblemException::forbidden('forbidden', __('End a live chat instead of closing it.'));
        }

        DB::transaction(function () use ($conversation, $from, $actor): void {
            $now = now();

            $affected = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', $from->value)
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::System->value,
                    'closed_at' => $now,
                    'rating_requested' => false,
                    'idle_expires_at' => null,
                ]);

            if ($affected === 0) {
                throw ApiProblemException::conflict('conversation_not_open', __('This conversation changed in the meantime.'));
            }

            if ($from === ConversationStatus::Queued) {
                ConversationOffer::query()
                    ->where('conversation_id', $conversation->id)
                    ->whereNull('responded_at')
                    ->update(['responded_at' => $now, 'response' => OfferResponse::Dismissed->value]);
            }

            $this->timeline->record($conversation, ConversationTimeline::CLOSED, $actor->is_admin ? ActorType::Admin : ActorType::Agent, $actor->id, [
                'reason' => ConversationCloseReason::System->value,
                'from' => $from->value,
            ]);
        });

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'widget'])->findOrFail($conversation->id);

        ConversationClosed::dispatch($fresh, ConversationCloseReason::System);

        if ($from === ConversationStatus::Queued) {
            QueueChanged::dispatch($fresh);
        }

        return $fresh;
    }
}
