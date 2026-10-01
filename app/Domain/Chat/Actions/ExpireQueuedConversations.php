<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use Illuminate\Support\Facades\DB;

/**
 * Queue timeout (decision P4-D4): a live chat nobody accepted before `queue_expires_at` becomes `missed` (terminal; the visitor
 * is offered the offline form). One guarded `UPDATE ... WHERE status = 'queued' AND queue_expires_at <= now` per chat, so a
 * claim that wins the race keeps the chat. Used by the delayed job and by the per-minute `chat:expire-queued` sweep.
 */
final class ExpireQueuedConversations
{
    public const CHUNK = 500;

    public function __construct(private readonly ConversationTimeline $timeline) {}

    /** Expire every due chat; returns how many were marked `missed`. */
    public function sweep(): int
    {
        $expired = 0;

        do {
            $ids = Conversation::query()
                ->where('status', ConversationStatus::Queued->value)
                ->where('type', ConversationType::Live->value)
                ->whereNotNull('queue_expires_at')
                ->where('queue_expires_at', '<=', now())
                ->orderBy('id')
                ->limit(self::CHUNK)
                ->pluck('id');

            $moved = 0;

            foreach ($ids as $id) {
                if ($this->expire((int) $id)) {
                    $moved++;
                }
            }

            $expired += $moved;
        } while ($moved > 0 && $ids->count() === self::CHUNK);

        return $expired;
    }

    /** Expire one chat if it is still queued and past its deadline. */
    public function expire(int $conversationId): bool
    {
        $expired = DB::transaction(function () use ($conversationId): bool {
            $affected = Conversation::query()
                ->whereKey($conversationId)
                ->where('status', ConversationStatus::Queued->value)
                ->where('type', ConversationType::Live->value)
                ->whereNotNull('queue_expires_at')
                ->where('queue_expires_at', '<=', now())
                ->update(['status' => ConversationStatus::Missed->value]);

            if ($affected === 0) {
                return false;
            }

            ConversationOffer::query()
                ->where('conversation_id', $conversationId)
                ->whereNull('responded_at')
                ->update(['responded_at' => now(), 'response' => OfferResponse::Expired->value]);

            $this->timeline->record($conversationId, ConversationTimeline::MISSED, ActorType::System);

            return true;
        });

        if ($expired) {
            $conversation = Conversation::query()->with(['widget', 'visitor', 'category', 'assignedAgent'])->findOrFail($conversationId);

            ConversationUpdated::dispatch($conversation);
            QueueChanged::dispatch($conversation);
        }

        return $expired;
    }
}
