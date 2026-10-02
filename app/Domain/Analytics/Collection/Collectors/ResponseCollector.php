<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * The FIRST agent message of each conversation, counted on the day it was sent (the sender's row):
 *  - live chat: the first response time (`frt_*`) = first agent message - first claim. A chat that was transferred before anybody wrote
 *    has one sample, for whoever wrote first;
 *  - offline ticket: `offline_answered` and `offline_response_sum_s` = first agent message - the day the ticket was created.
 */
final class ResponseCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        DB::table('messages as m')
            ->join('conversations as c', 'c.id', '=', 'm.conversation_id')
            ->where('m.sender_type', 'agent')
            ->where('m.created_at', '>=', $window->startDb())
            ->where('m.created_at', '<', $window->endDb())
            ->whereNotExists(function ($earlier): void {
                $earlier->selectRaw('1')
                    ->from('messages as p')
                    ->whereColumn('p.conversation_id', 'm.conversation_id')
                    ->where('p.sender_type', 'agent')
                    ->whereColumn('p.id', '<', 'm.id');
            })
            ->orderBy('m.id')
            ->select(['m.id as message_id', 'm.conversation_id', 'm.sender_user_id', 'm.created_at as sent_at', 'c.type', 'c.widget_id', 'c.category_id', 'c.created_at as conversation_created_at'])
            ->chunkById(1000, function ($rows) use ($context): void {
                $context->claims->load(array_map(static fn (object $row): int => (int) $row->conversation_id, $rows->all()));

                foreach ($rows as $row) {
                    $sentAt = DayWindow::parseDb($row->sent_at);

                    if ($sentAt === null) {
                        continue;
                    }

                    $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id)
                        ->byAgent($row->sender_user_id === null ? null : (int) $row->sender_user_id);

                    if ($row->type === 'live') {
                        $claim = $context->claims->get((int) $row->conversation_id);

                        if ($claim === null) {
                            continue;
                        }

                        $seconds = max(0, $sentAt - $claim['first_at']);
                        $context->metrics->add($to, 'frt_sum_s', $seconds);
                        $context->metrics->add($to, 'frt_count');
                        $context->metrics->max($to, 'frt_max_s', $seconds);

                        continue;
                    }

                    $created = DayWindow::parseDb($row->conversation_created_at) ?? $sentAt;
                    $context->metrics->add($to, 'offline_answered');
                    $context->metrics->add($to, 'offline_response_sum_s', max(0, $sentAt - $created));
                }
            }, 'm.id', 'message_id');
    }
}
