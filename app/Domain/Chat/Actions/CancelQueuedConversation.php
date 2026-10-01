<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use Illuminate\Support\Facades\DB;

/**
 * The visitor gives up while still queued (`POST /public/conversations/{ulid}/cancel`): `queued -> closed` with reason
 * `cancelled`. Guarded on `status = 'queued'`: a chat an agent accepted a moment earlier is not cancelled (`409 conversation_not_queued`;
 * the visitor ends it instead). The agents' pending offers end with it.
 */
final class CancelQueuedConversation
{
    public function __construct(private readonly ConversationTimeline $timeline) {}

    public function handle(Conversation $conversation): Conversation
    {
        DB::transaction(function () use ($conversation): void {
            $now = now();

            $affected = Conversation::query()
                ->whereKey($conversation->id)
                ->where('status', ConversationStatus::Queued->value)
                ->where('type', ConversationType::Live->value)
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::Cancelled->value,
                    'closed_at' => $now,
                ]);

            if ($affected === 0) {
                throw ApiProblemException::conflict('conversation_not_queued', __('This chat is no longer waiting for an agent.'));
            }

            ConversationOffer::query()
                ->where('conversation_id', $conversation->id)
                ->whereNull('responded_at')
                ->update(['responded_at' => $now, 'response' => OfferResponse::Expired->value]);

            $this->timeline->record($conversation, ConversationTimeline::CANCELLED, ActorType::Visitor, $conversation->visitor_id);
        });

        $fresh = Conversation::query()->with(['category', 'assignedAgent', 'visitor', 'visitorSession', 'widget'])->findOrFail($conversation->id);

        ConversationClosed::dispatch($fresh, ConversationCloseReason::Cancelled);
        QueueChanged::dispatch($fresh);

        return $fresh;
    }
}
