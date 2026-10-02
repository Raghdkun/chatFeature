<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * Claims (`claimed` events of live chats) in the day. The first claim of a chat is `handled` and measures the wait (the chat was created,
 * so it was queued, until an agent accepted it: `wait_*`), attributed to the agent who accepted; every later claim of the same chat (it was
 * transferred and somebody accepted it again) is `reclaimed`. The slots count every claim.
 */
final class ClaimCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        DB::table('conversation_events as e')
            ->join('conversations as c', 'c.id', '=', 'e.conversation_id')
            ->where('e.type', 'claimed')
            ->where('c.type', 'live')
            ->where('e.created_at', '>=', $window->startDb())
            ->where('e.created_at', '<', $window->endDb())
            ->orderBy('e.id')
            ->select(['e.id as event_id', 'e.conversation_id', 'e.actor_id', 'e.created_at as claimed_at', 'c.widget_id', 'c.category_id', 'c.created_at as conversation_created_at'])
            ->chunkById(1000, function ($rows) use ($context): void {
                $context->claims->load(array_map(static fn (object $row): int => (int) $row->conversation_id, $rows->all()));

                foreach ($rows as $row) {
                    $claim = $context->claims->get((int) $row->conversation_id);
                    $agent = $row->actor_id === null ? null : (int) $row->actor_id;
                    $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id)->byAgent($agent);
                    $at = DayWindow::parseDb($row->claimed_at) ?? 0;

                    $context->metrics->slot($at, $to, 'claimed');

                    if ($claim === null || $claim['first_id'] !== (int) $row->event_id) {
                        $context->metrics->add($to, 'reclaimed');

                        continue;
                    }

                    $context->metrics->add($to, 'handled');
                    $created = DayWindow::parseDb($row->conversation_created_at);

                    if ($created !== null) {
                        $wait = max(0, $at - $created);
                        $context->metrics->add($to, 'wait_sum_s', $wait);
                        $context->metrics->add($to, 'wait_count');
                        $context->metrics->max($to, 'wait_max_s', $wait);
                    }
                }
            }, 'e.id', 'event_id');
    }
}
