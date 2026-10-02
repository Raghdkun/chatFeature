<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsMetaData;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Widgets\Support\Timestamps;

/** Builds the freshness block every report carries. */
final class MetaFactory
{
    /**
     * @param  array{today: bool, rolledUpTo: string|null, missing: int, timezoneChanged: bool}  $completion
     */
    public static function from(AnalyticsQuery $query, array $completion, int $extraMissing = 0): AnalyticsMetaData
    {
        return new AnalyticsMetaData(
            timezone: $query->timezone,
            today: $query->today,
            live: $completion['today'],
            rolledUpTo: $completion['rolledUpTo'],
            missingDays: $completion['missing'] + $extraMissing,
            timezoneChanged: $completion['timezoneChanged'],
            generatedAt: (string) Timestamps::iso(now()),
        );
    }

    public static function fromResult(AnalyticsQuery $query, ReadResult $result, int $extraMissing = 0): AnalyticsMetaData
    {
        return self::from($query, [
            'today' => $result->live,
            'rolledUpTo' => $result->rolledUpTo,
            'missing' => $result->missingDays,
            'timezoneChanged' => $result->timezoneChanged,
        ], $extraMissing);
    }
}
