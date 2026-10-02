<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Collection\SweepPoints;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * The busiest moments of the day, by a sweep over intervals rebuilt from each live chat's events:
 *  - queued: from `created` (or a `transferred` / `requeued`) until the chat is claimed, missed, cancelled or closed;
 *  - active: from `claimed` until it is transferred, re-queued, ended or closed, belonging to the agent who claimed it.
 * `queue_peak` is the most chats queued at the same moment, `peak_concurrent` the most chats active at the same moment (in an agent's row:
 * that agent's own chats). A chat still open at the end of the window (or "now", for today) is open until then. Chats without any lifecycle
 * event in the `LOOKBACK_SECONDS` before the day (or in it) are not looked at: an interval that long is a stuck row, not a conversation.
 * Concurrency of one instant is exact to the second; an interval that opens and closes in the same second occupies that second.
 */
final class SweepCollector implements MetricCollector
{
    public const LOOKBACK_SECONDS = 72 * 3600;

    private const TYPES = ['created', 'claimed', 'transferred', 'requeued', 'ended', 'closed', 'missed', 'cancelled'];

    public function collect(DayContext $context): void
    {
        $window = $context->window;
        $limit = min($window->endTs, $context->nowTs);

        if ($limit <= $window->startTs) {
            return;
        }

        $ids = DB::table('conversation_events as e')
            ->join('conversations as c', 'c.id', '=', 'e.conversation_id')
            ->where('c.type', 'live')
            ->whereIn('e.type', self::TYPES)
            ->where('e.created_at', '>=', $window->startDbMinus(self::LOOKBACK_SECONDS))
            ->where('e.created_at', '<', $window->endDb())
            ->distinct()
            ->pluck('e.conversation_id')
            ->map(static fn (mixed $id): int => (int) $id)
            ->all();

        $points = new SweepPoints($window->startTs, $limit);

        foreach (array_chunk($ids, 500) as $chunk) {
            $events = DB::table('conversation_events as e')
                ->join('conversations as c', 'c.id', '=', 'e.conversation_id')
                ->whereIn('e.conversation_id', $chunk)
                ->whereIn('e.type', self::TYPES)
                ->orderBy('e.conversation_id')
                ->orderBy('e.id')
                ->get(['e.conversation_id', 'e.type', 'e.actor_id', 'e.created_at', 'c.widget_id', 'c.category_id', 'c.status', 'c.ended_at', 'c.closed_at', 'c.queue_expires_at', 'c.updated_at']);

            foreach ($events->groupBy('conversation_id') as $conversationEvents) {
                $this->walk(array_values($conversationEvents->all()), $points);
            }
        }

        $points->writePeaks($context->metrics);
    }

    /**
     * One conversation's events, in order, as queue and active intervals.
     *
     * @param  list<\stdClass>  $events
     */
    private function walk(array $events, SweepPoints $points): void
    {
        $first = $events[0];
        $widget = (int) $first->widget_id;
        $category = $first->category_id === null ? 0 : (int) $first->category_id;
        $queuedSince = null;
        $activeSince = null;
        $agent = null;

        foreach ($events as $event) {
            $at = DayWindow::parseDb($event->created_at) ?? 0;

            switch ($event->type) {
                case 'created':
                    $queuedSince ??= $at;
                    break;
                case 'claimed':
                    if ($queuedSince !== null) {
                        $points->add(SweepPoints::QUEUE, $widget, $category, null, $queuedSince, $at);
                        $queuedSince = null;
                    }

                    if ($activeSince === null) {
                        $activeSince = $at;
                        $agent = $event->actor_id === null ? null : (int) $event->actor_id;
                    }
                    break;
                case 'transferred':
                case 'requeued':
                    if ($activeSince !== null) {
                        $points->add(SweepPoints::ACTIVE, $widget, $category, $agent ?? 0, $activeSince, $at);
                        $activeSince = null;
                    }

                    $queuedSince ??= $at;
                    break;
                case 'ended':
                    if ($activeSince !== null) {
                        $points->add(SweepPoints::ACTIVE, $widget, $category, $agent ?? 0, $activeSince, $at);
                        $activeSince = null;
                    }
                    break;
                default: // closed, missed, cancelled
                    if ($activeSince !== null) {
                        $points->add(SweepPoints::ACTIVE, $widget, $category, $agent ?? 0, $activeSince, $at);
                        $activeSince = null;
                    }

                    if ($queuedSince !== null) {
                        $points->add(SweepPoints::QUEUE, $widget, $category, null, $queuedSince, $at);
                        $queuedSince = null;
                    }
            }
        }

        // Still open after the last event: until now / the end of the window, unless the row says it is over (events can be missing).
        $over = null;

        if (! in_array((string) $first->status, ['queued', 'active'], true)) {
            $over = DayWindow::parseDb($first->ended_at) ?? DayWindow::parseDb($first->closed_at) ?? DayWindow::parseDb($first->queue_expires_at) ?? DayWindow::parseDb($first->updated_at);
        }

        if ($queuedSince !== null) {
            $points->add(SweepPoints::QUEUE, $widget, $category, null, $queuedSince, $over);
        }

        if ($activeSince !== null) {
            $points->add(SweepPoints::ACTIVE, $widget, $category, $agent ?? 0, $activeSince, $over);
        }
    }
}
