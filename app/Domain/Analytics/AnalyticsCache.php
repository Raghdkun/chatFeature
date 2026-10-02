<?php

namespace App\Domain\Analytics;

use App\Domain\Analytics\Actions\RollupRange;
use Closure;
use Illuminate\Support\Facades\Cache;

/**
 * Short-lived cache of finished reports. The key holds everything that changes the answer (report, role scope, range, filters, time zones)
 * plus the epoch a rollup run moves, so a report never outlives a run, and an agent's report can never be served to an administrator or
 * to another agent. A report that includes today lives `analytics.report_ttl` seconds, one of finished days `analytics.past_report_ttl`.
 */
final class AnalyticsCache
{
    /**
     * @template T
     *
     * @param  array<string, mixed>  $extra
     * @param  Closure(): T  $build
     * @return T
     */
    public function remember(string $report, AnalyticsQuery $query, array $extra, Closure $build): mixed
    {
        $ttl = (int) config($query->includesToday() || ($query->compare && $query->includesToday($query->previousRange()->from, $query->previousRange()->to)) ? 'analytics.report_ttl' : 'analytics.past_report_ttl', 60);

        if ($ttl <= 0) {
            return $build();
        }

        $epoch = (string) Cache::get(RollupRange::CACHE_EPOCH_KEY, '0');
        $key = 'analytics:report:'.$report.':'.sha1(json_encode([$epoch, $query->cacheParts($extra)], JSON_THROW_ON_ERROR));

        return Cache::remember($key, $ttl, $build);
    }
}
