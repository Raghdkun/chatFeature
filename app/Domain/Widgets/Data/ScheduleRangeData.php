<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One opening range: `day` 0 = Sunday .. 6 = Saturday, `start`/`end` as 24 h `HH:MM` (end `24:00` = midnight). */
#[TypeScript]
class ScheduleRangeData extends Data
{
    public function __construct(
        public int $day,
        public string $start,
        public string $end,
    ) {}
}
