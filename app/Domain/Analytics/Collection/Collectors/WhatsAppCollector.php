<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * WhatsApp numbers of the day, ADMIN-ONLY (the `whatsapp` dimension, which no agent endpoint reads):
 *  - `wa_chats_new` (chats created in the day) and `wa_chats_linked` (of those, the ones matched to a widget visitor by a hand-off ticket);
 *  - `wa_inbound` / `wa_outbound` (messages by `wa_timestamp`; an outbound message counts once OpenWA took it: not pending, not failed);
 *  - the response time: an outbound message sent in the day answers the oldest inbound message of the same chat that nobody answered
 *    yet; the sample (`wa_response_*`) is the gap between the two. The look-back for that inbound message is `RESPONSE_LOOKBACK_SECONDS`.
 */
final class WhatsAppCollector implements MetricCollector
{
    public const RESPONSE_LOOKBACK_SECONDS = 7 * 86400;

    private const SENT = ['sent', 'delivered', 'read'];

    public function collect(DayContext $context): void
    {
        $this->chats($context);
        $this->messages($context);
        $this->responses($context);
    }

    private function chats(DayContext $context): void
    {
        $window = $context->window;

        $row = DB::table('wa_chats')
            ->where('created_at', '>=', $window->startDb())
            ->where('created_at', '<', $window->endDb())
            ->selectRaw('COUNT(*) as total, COALESCE(SUM(CASE WHEN widget_id IS NOT NULL THEN 1 ELSE 0 END), 0) as linked')
            ->first();

        $context->metrics->bump(AnalyticsColumns::WHATSAPP, '', 'wa_chats_new', (int) ($row->total ?? 0));
        $context->metrics->bump(AnalyticsColumns::WHATSAPP, '', 'wa_chats_linked', (int) ($row->linked ?? 0));
    }

    private function messages(DayContext $context): void
    {
        $window = $context->window;

        $rows = DB::table('wa_messages')
            ->where('wa_timestamp', '>=', $window->startDb())
            ->where('wa_timestamp', '<', $window->endDb())
            ->where(function ($query): void {
                $query->where('direction', 'in')->orWhereIn('status', self::SENT);
            })
            ->groupBy('direction')
            ->selectRaw('direction, COUNT(*) as total')
            ->get();

        foreach ($rows as $row) {
            $context->metrics->bump(AnalyticsColumns::WHATSAPP, '', $row->direction === 'in' ? 'wa_inbound' : 'wa_outbound', (int) $row->total);
        }
    }

    private function responses(DayContext $context): void
    {
        $window = $context->window;

        $chatIds = DB::table('wa_messages')
            ->where('direction', 'out')
            ->whereIn('status', self::SENT)
            ->where('wa_timestamp', '>=', $window->startDb())
            ->where('wa_timestamp', '<', $window->endDb())
            ->distinct()
            ->pluck('wa_chat_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all();

        foreach (array_chunk($chatIds, 300) as $chunk) {
            $messages = DB::table('wa_messages')
                ->whereIn('wa_chat_id', $chunk)
                ->where('wa_timestamp', '>=', $window->startDbMinus(self::RESPONSE_LOOKBACK_SECONDS))
                ->where('wa_timestamp', '<', $window->endDb())
                ->orderBy('wa_chat_id')
                ->orderBy('wa_timestamp')
                ->orderBy('id')
                ->get(['wa_chat_id', 'direction', 'status', 'wa_timestamp']);

            $chat = null;
            $waitingSince = null;

            foreach ($messages as $message) {
                if ((int) $message->wa_chat_id !== $chat) {
                    $chat = (int) $message->wa_chat_id;
                    $waitingSince = null;
                }

                $at = DayWindow::parseDb($message->wa_timestamp);

                if ($at === null) {
                    continue;
                }

                if ($message->direction === 'in') {
                    $waitingSince ??= $at;

                    continue;
                }

                if (! in_array($message->status, self::SENT, true)) {
                    continue;
                }

                if ($waitingSince !== null && $at >= $window->startTs) {
                    $context->metrics->bump(AnalyticsColumns::WHATSAPP, '', 'wa_response_sum_s', max(0, $at - $waitingSince));
                    $context->metrics->bump(AnalyticsColumns::WHATSAPP, '', 'wa_response_count');
                }

                $waitingSince = null;
            }
        }
    }
}
