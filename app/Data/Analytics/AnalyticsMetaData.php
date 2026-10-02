<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * How trustworthy the numbers are right now. `live` = the range includes today, which is computed on the spot (the same code as the
 * rollup); `rolledUpTo` = the last day with a stored rollup; `missingDays` = past days nobody rolled up yet (up to 14 are computed on the
 * spot, the rest count as empty: run `php artisan analytics:rollup`); `timezoneChanged` = stored days were counted in another time zone
 * than the current setting (a backfill with `--force` rebuilds them).
 */
#[TypeScript]
class AnalyticsMetaData extends Data
{
    public function __construct(
        public string $timezone,
        public string $today,
        public bool $live,
        public ?string $rolledUpTo,
        public int $missingDays,
        public bool $timezoneChanged,
        public string $generatedAt,
    ) {}
}
