<?php

namespace App\Domain\Chat\Actions;

use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Models\Conversation;
use App\Models\Message;
use Illuminate\Support\Facades\DB;

/**
 * Delivery and read receipts (decision P4-D7). `delivered_upto` / `seen_upto` are message numbers (`seq`): they stamp
 * `delivered_at` / `seen_at` on the messages of the OTHER side up to that number (reading implies delivery), then the viewer's
 * unseen counter is set to what is still unread. The conversation row is locked while that happens so a message arriving at the
 * same moment cannot be lost from the counter. `MessagesSeen` is dispatched only when a message was newly marked seen.
 * Numbers past the last message are clamped; system messages carry no receipts.
 */
final class RecordReceipts
{
    /**
     * @param  SenderType  $by  the side that read: `visitor` marks agent messages, `agent` marks visitor messages
     */
    public function handle(Conversation $conversation, SenderType $by, ?int $deliveredUpto, ?int $seenUpto): void
    {
        $other = $by === SenderType::Visitor ? SenderType::Agent : SenderType::Visitor;

        $result = DB::transaction(function () use ($conversation, $other, $by, $deliveredUpto, $seenUpto): array {
            $locked = Conversation::query()->whereKey($conversation->id)->lockForUpdate()->firstOrFail();
            $now = now();

            $seen = min(max(0, (int) $seenUpto), $locked->last_seq);
            $delivered = min(max(0, (int) $deliveredUpto, $seen), $locked->last_seq);

            $messages = fn () => Message::query()->where('conversation_id', $locked->id)->where('sender_type', $other->value);

            if ($delivered > 0) {
                $messages()->where('seq', '<=', $delivered)->whereNull('delivered_at')->update(['delivered_at' => $now]);
            }

            $newlySeen = $seen > 0 ? $messages()->where('seq', '<=', $seen)->whereNull('seen_at')->update(['seen_at' => $now]) : 0;

            $remaining = $messages()->whereNull('seen_at')->count();
            $column = $by === SenderType::Agent ? 'unseen_by_agent' : 'unseen_by_visitor';
            $changed = $locked->{$column} !== $remaining;

            if ($changed) {
                Conversation::query()->whereKey($locked->id)->update([$column => $remaining]);
            }

            return ['seen' => $seen, 'newly_seen' => $newlySeen, 'counter_changed' => $changed, 'conversation' => $locked];
        });

        if ($result['newly_seen'] > 0) {
            MessagesSeen::dispatch($result['conversation'], $result['seen'], $by);
        }

        if ($by === SenderType::Agent && $result['counter_changed']) {
            UnseenCountChanged::dispatch(Conversation::query()->findOrFail($conversation->id));
        }
    }
}
