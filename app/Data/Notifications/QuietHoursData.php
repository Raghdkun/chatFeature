<?php

namespace App\Data\Notifications;

use App\Domain\Notifications\Support\QuietHours;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The "do not push me" window: `HH:MM` wall-clock times in an IANA timezone; `start` after `end` runs overnight. */
#[TypeScript]
class QuietHoursData extends Data
{
    public function __construct(
        public bool $enabled,
        public string $start,
        public string $end,
        public string $timezone,
    ) {}

    public static function fromValue(QuietHours $hours): self
    {
        return new self($hours->enabled, $hours->start, $hours->end, $hours->timezone);
    }
}
