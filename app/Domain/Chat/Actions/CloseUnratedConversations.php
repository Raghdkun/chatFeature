<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\ActorType;
use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Services\ConversationTimeline;
use App\Models\Conversation;
use Illuminate\Support\Facades\DB;

/**
 * A chat that ended and was never rated closes when its rating window (`chat.rating_window_minutes`) is over: reason `timeout`.
 */
final class CloseUnratedConversations
{
    public const CHUNK = 500;

    public function __construct(private readonly ConversationTimeline $timeline) {}

    public function handle(): int
    {
        $closed = 0;

        do {
            $ids = Conversation::query()
                ->where('status', ConversationStatus::Ended->value)
                ->where('rating_window_expires_at', '<=', now())
                ->orderBy('id')
                ->limit(self::CHUNK)
                ->pluck('id');

            $moved = 0;

            foreach ($ids as $id) {
                if ($this->close((int) $id)) {
                    $moved++;
                }
            }

            $closed += $moved;
        } while ($moved > 0 && $ids->count() === self::CHUNK);

        return $closed;
    }

    private function close(int $conversationId): bool
    {
        $closed = DB::transaction(function () use ($conversationId): bool {
            $affected = Conversation::query()
                ->whereKey($conversationId)
                ->where('status', ConversationStatus::Ended->value)
                ->where('rating_window_expires_at', '<=', now())
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::Timeout->value,
                    'closed_at' => now(),
                    'rating_requested' => false,
                ]);

            if ($affected === 0) {
                return false;
            }

            $this->timeline->record($conversationId, ConversationTimeline::CLOSED, ActorType::System, payload: ['reason' => ConversationCloseReason::Timeout->value]);

            return true;
        });

        if ($closed) {
            ConversationClosed::dispatch(Conversation::query()->with(['widget', 'visitor', 'visitorSession', 'category', 'assignedAgent'])->findOrFail($conversationId), ConversationCloseReason::Timeout);
        }

        return $closed;
    }
}
