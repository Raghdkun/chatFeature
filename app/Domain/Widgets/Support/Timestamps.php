<?php

namespace App\Domain\Widgets\Support;

use Carbon\CarbonInterface;

/** ISO-8601 UTC timestamps with milliseconds, the format every API uses (docs/contracts/rest-shapes.md). */
final class Timestamps
{
    public static function iso(?CarbonInterface $moment): ?string
    {
        return $moment?->clone()->utc()->format('Y-m-d\TH:i:s.v\Z');
    }
}
