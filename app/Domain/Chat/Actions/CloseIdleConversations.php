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
 * Idle rule (docs/contracts/realtime-events.md "Timers"): an active chat whose `idle_expires_at` passed (no message from either
 * side for the widget's idle timeout) is closed with reason `idle` and no rating prompt. Runs every minute in chunks of 500 with
 * a guarded `UPDATE ... WHERE status = 'active' AND idle_expires_at < now`. Offline tickets have no idle deadline.
 */
final class CloseIdleConversations
{
    public const CHUNK = 500;

    public function __construct(private readonly ConversationTimeline $timeline) {}

    public function handle(): int
    {
        $closed = 0;

        do {
            $ids = Conversation::query()
                ->where('status', ConversationStatus::Active->value)
                ->where('idle_expires_at', '<', now())
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
                ->where('status', ConversationStatus::Active->value)
                ->where('idle_expires_at', '<', now())
                ->update([
                    'status' => ConversationStatus::Closed->value,
                    'close_reason' => ConversationCloseReason::Idle->value,
                    'closed_at' => now(),
                ]);

            if ($affected === 0) {
                return false;
            }

            $this->timeline->record($conversationId, ConversationTimeline::CLOSED, ActorType::System, payload: ['reason' => ConversationCloseReason::Idle->value]);

            return true;
        });

        if ($closed) {
            ConversationClosed::dispatch(Conversation::query()->with(['widget', 'visitor', 'visitorSession', 'category', 'assignedAgent'])->findOrFail($conversationId), ConversationCloseReason::Idle);
        }

        return $closed;
    }
}
