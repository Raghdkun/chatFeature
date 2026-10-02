<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * `started` (live chats created in the day, also in the 15-minute slots) and `offline_created` (offline tickets created in the day),
 * attributed to the widget and the topic the conversation was created for (its topic now: a transfer to another topic moves it).
 */
final class ConversationStartCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        DB::table('conversations')
            ->where('created_at', '>=', $window->startDb())
            ->where('created_at', '<', $window->endDb())
            ->orderBy('id')
            ->select(['id', 'type', 'widget_id', 'category_id', 'created_at'])
            ->chunkById(2000, function ($rows) use ($context): void {
                foreach ($rows as $row) {
                    $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id);

                    if ($row->type === 'live') {
                        $context->metrics->add($to, 'started');
                        $at = DayWindow::parseDb($row->created_at);

                        if ($at !== null) {
                            $context->metrics->slot($at, $to, 'started');
                        }
                    } else {
                        $context->metrics->add($to, 'offline_created');
                    }
                }
            });
    }
}
