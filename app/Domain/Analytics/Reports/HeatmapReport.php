<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsHeatmapData;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\DayWindow;
use DateTimeImmutable;
use DateTimeZone;
use Illuminate\Support\Facades\DB;

/**
 * `GET /analytics/heatmap`: how busy each weekday x hour of the VIEWER's time zone is. The 15-minute slots are UTC instants; each is moved to
 * the viewer's zone (so DST days and half-hour zones come out right) and added to its weekday / hour cell. The range is the same
 * application-time-zone days as every other report; today (and any past day nobody rolled up) comes from the live computation.
 */
final class HeatmapReport
{
    public function __construct(private readonly RowReader $reader) {}

    public function handle(AnalyticsQuery $query, string $metric): AnalyticsHeatmapData
    {
        $scope = $query->scope;
        $zone = new DateTimeZone($query->viewerTimezone);
        $start = DayWindow::forDate($query->from, $query->timezone);
        $end = DayWindow::forDate($query->to, $query->timezone);
        $completion = $this->reader->completion($query->from, $query->to);
        $matrix = array_fill(0, 7, array_fill(0, 24, 0));

        $add = function (int $slot, int $count) use (&$matrix, $zone): void {
            $local = (new DateTimeImmutable('@'.$slot))->setTimezone($zone);
            $matrix[(int) $local->format('N') - 1][(int) $local->format('G')] += $count;
        };

        // Days computed live replace whatever is stored for them.
        $skip = [];

        foreach (array_keys($completion['live']) as $date) {
            $window = DayWindow::forDate($date, $query->timezone);
            $skip[] = [$window->startTs, $window->endTs];
        }

        $stored = DB::table('analytics_slots')
            ->where('dimension', $scope->dimension)
            ->where('dimension_key', $scope->key)
            ->where('slot_start', '>=', $start->startDb())
            ->where('slot_start', '<', $end->endDb())
            ->where($metric, '>', 0)
            ->orderBy('id')
            ->get(['slot_start', $metric]);

        foreach ($stored as $row) {
            $slot = DayWindow::parseDb($row->slot_start);

            if ($slot === null || $this->inside($slot, $skip)) {
                continue;
            }

            $add($slot, (int) $row->{$metric});
        }

        foreach ($completion['live'] as $payload) {
            foreach ($payload['slots'] as $slotRow) {
                if ($slotRow['dimension'] === $scope->dimension && $slotRow['key'] === $scope->key && ($slotRow['values'][$metric] ?? 0) > 0) {
                    $add($slotRow['slot'], $slotRow['values'][$metric]);
                }
            }
        }

        $flat = array_merge(...$matrix);

        return new AnalyticsHeatmapData(
            timezone: $query->viewerTimezone,
            metric: $metric,
            range: $query->range(),
            matrix: $matrix,
            max: max($flat),
            total: array_sum($flat),
            meta: MetaFactory::from($query, $completion),
        );
    }

    /**
     * @param  list<array{0: int, 1: int}>  $windows
     */
    private function inside(int $timestamp, array $windows): bool
    {
        foreach ($windows as [$from, $to]) {
            if ($timestamp >= $from && $timestamp < $to) {
                return true;
            }
        }

        return false;
    }
}
