<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use Illuminate\Support\Facades\DB;

/**
 * Ratings given in the day (`ratings.created_at`): `rating_count`, `rating_sum` and the five `rating_<score>` buckets, in the row of the
 * agent who held the chat last (so an average rating per agent is exact). Scores outside 1-5 cannot be written by the API and are ignored.
 */
final class RatingCollector implements MetricCollector
{
    public function collect(DayContext $context): void
    {
        $window = $context->window;

        DB::table('ratings as r')
            ->join('conversations as c', 'c.id', '=', 'r.conversation_id')
            ->where('r.created_at', '>=', $window->startDb())
            ->where('r.created_at', '<', $window->endDb())
            ->orderBy('r.id')
            ->select(['r.id as rating_id', 'r.conversation_id', 'r.score', 'c.widget_id', 'c.category_id'])
            ->chunkById(1000, function ($rows) use ($context): void {
                $context->claims->load(array_map(static fn (object $row): int => (int) $row->conversation_id, $rows->all()));

                foreach ($rows as $row) {
                    $score = (int) $row->score;

                    if ($score < 1 || $score > 5) {
                        continue;
                    }

                    $claim = $context->claims->get((int) $row->conversation_id);
                    $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id)->byAgent($claim['last_actor'] ?? null);

                    $context->metrics->add($to, 'rating_count');
                    $context->metrics->add($to, 'rating_sum', $score);
                    $context->metrics->add($to, 'rating_'.$score);
                }
            }, 'r.id', 'rating_id');
    }
}
