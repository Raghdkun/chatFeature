<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\Support\DayWindow;

/**
 * What a collector gets: the day, the numbers it adds to, the shared claim index and the clock (so "now" is one instant for the whole run).
 */
final class DayContext
{
    public function __construct(
        public readonly DayWindow $window,
        public readonly DayMetrics $metrics,
        public readonly ClaimIndex $claims,
        public readonly int $nowTs,
    ) {}

    /** Whether the day has not ended yet (a live, partial day). */
    public function isOpen(): bool
    {
        return $this->nowTs < $this->window->endTs;
    }
}
