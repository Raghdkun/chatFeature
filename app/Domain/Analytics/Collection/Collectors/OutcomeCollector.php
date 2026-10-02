<?php

namespace App\Domain\Analytics\Collection\Collectors;

use App\Domain\Analytics\Collection\Attribution;
use App\Domain\Analytics\Collection\DayContext;
use App\Domain\Analytics\Collection\MetricCollector;
use App\Domain\Analytics\Support\DayWindow;
use Illuminate\Support\Facades\DB;

/**
 * How conversations finished, counted on the day it happened:
 *  - `ended` (`ended_at` in the day) and the `closed_<reason>` counters (`closed_at` in the day) of live chats; `offline_closed` for tickets;
 *  - a live chat is TERMINATED when it leaves the agent for good: at `ended_at`, or, when it was never ended, at `closed_at` if an agent had
 *    accepted it (the idle sweep, or staff closing it). Terminated chats are the "resolution" (`res_visitor` / `res_agent` / `res_system` /
 *    `res_idle`), measure the handling time (first claim -> termination) and the messages per chat (visitor + agent messages, final at that
 *    moment), all in the row of the agent who held it last (the `claimed` event keeps the id even after the account is deleted).
 */
final class OutcomeCollector implements MetricCollector
{
    private const CLOSE_REASONS = ['rated', 'skipped', 'idle', 'timeout', 'system', 'cancelled'];

    public function collect(DayContext $context): void
    {
        $window = $context->window;
        $from = $window->startDb();
        $to = $window->endDb();

        DB::table('conversations')
            ->where(function ($query) use ($from, $to): void {
                $query->where(fn ($ended) => $ended->where('ended_at', '>=', $from)->where('ended_at', '<', $to))
                    ->orWhere(fn ($closed) => $closed->where('closed_at', '>=', $from)->where('closed_at', '<', $to));
            })
            ->orderBy('id')
            ->select(['id', 'type', 'widget_id', 'category_id', 'ended_at', 'ended_by', 'closed_at', 'close_reason'])
            ->chunkById(1000, function ($rows) use ($context): void {
                $this->chunk($context, array_values($rows->all()));
            });
    }

    /**
     * @param  list<\stdClass>  $rows
     */
    private function chunk(DayContext $context, array $rows): void
    {
        $window = $context->window;
        $liveIds = [];

        foreach ($rows as $row) {
            if ($row->type === 'live') {
                $liveIds[] = (int) $row->id;
            }
        }

        $context->claims->load($liveIds);

        /** @var list<array{row: \stdClass, at: int, ended: bool, resolution: string, claim: array{first_id: int, first_at: int, first_actor: int|null, last_actor: int|null}|null}> $terminated */
        $terminated = [];

        foreach ($rows as $row) {
            $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id);
            $endedAt = DayWindow::parseDb($row->ended_at);
            $closedAt = DayWindow::parseDb($row->closed_at);
            $endedToday = $endedAt !== null && $endedAt >= $window->startTs && $endedAt < $window->endTs;
            $closedToday = $closedAt !== null && $closedAt >= $window->startTs && $closedAt < $window->endTs;

            if ($row->type !== 'live') {
                if ($closedToday) {
                    $context->metrics->add($to, 'offline_closed');
                }

                continue;
            }

            if ($closedToday) {
                $reason = in_array($row->close_reason, self::CLOSE_REASONS, true) ? (string) $row->close_reason : 'system';
                $context->metrics->add($to, 'closed_'.$reason);
            }

            $claim = $context->claims->get((int) $row->id);

            if ($endedToday) {
                $terminated[] = ['row' => $row, 'at' => (int) $endedAt, 'ended' => true, 'resolution' => $this->endedResolution($row->ended_by), 'claim' => $claim];
            } elseif ($closedToday && $endedAt === null && $claim !== null) {
                $terminated[] = ['row' => $row, 'at' => (int) $closedAt, 'ended' => false, 'resolution' => $row->close_reason === 'idle' ? 'res_idle' : 'res_system', 'claim' => $claim];
            }
        }

        $messages = $this->messageCounts(array_map(static fn (array $entry): int => (int) $entry['row']->id, $terminated));

        foreach ($terminated as $entry) {
            $row = $entry['row'];
            $claim = $entry['claim'];
            $to = Attribution::conversation((int) $row->widget_id, $row->category_id === null ? null : (int) $row->category_id)->byAgent($claim['last_actor'] ?? null);

            if ($entry['ended']) {
                $context->metrics->add($to, 'ended');
            }

            $context->metrics->add($to, $entry['resolution']);
            $context->metrics->add($to, 'msgs_sum', $messages[(int) $row->id] ?? 0);
            $context->metrics->add($to, 'msgs_count');

            if ($claim !== null) {
                $handling = max(0, $entry['at'] - $claim['first_at']);
                $context->metrics->add($to, 'handling_sum_s', $handling);
                $context->metrics->add($to, 'handling_count');
                $context->metrics->max($to, 'handling_max_s', $handling);
            }
        }
    }

    private function endedResolution(mixed $endedBy): string
    {
        return match ($endedBy) {
            'visitor' => 'res_visitor',
            'agent', 'admin' => 'res_agent',
            default => 'res_system',
        };
    }

    /**
     * Visitor and agent messages per conversation (system lines such as "joined the chat" are not messages of the conversation).
     *
     * @param  list<int>  $conversationIds
     * @return array<int, int>
     */
    private function messageCounts(array $conversationIds): array
    {
        $counts = [];

        foreach (array_chunk($conversationIds, 500) as $chunk) {
            $rows = DB::table('messages')
                ->whereIn('conversation_id', $chunk)
                ->whereIn('sender_type', ['visitor', 'agent'])
                ->groupBy('conversation_id')
                ->selectRaw('conversation_id, COUNT(*) as total')
                ->get();

            foreach ($rows as $row) {
                $counts[(int) $row->conversation_id] = (int) $row->total;
            }
        }

        return $counts;
    }
}
