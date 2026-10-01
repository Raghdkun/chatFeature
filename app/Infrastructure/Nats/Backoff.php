<?php

namespace App\Infrastructure\Nats;

use Closure;

/**
 * Exponential reconnect delay (initial, 2x, 4x ... capped at max) with "equal jitter": each delay is a random
 * value between 50% and 100% of the step, so many consumers never reconnect in lockstep.
 */
final class Backoff
{
    private int $attempt = 0;

    /**
     * @param  (Closure(): float)|null  $random  returns a float in [0, 1]; default mt_rand based
     */
    public function __construct(
        private readonly float $initialSeconds,
        private readonly float $maxSeconds,
        private readonly ?Closure $random = null,
    ) {}

    public function next(): float
    {
        $step = min($this->maxSeconds, $this->initialSeconds * (2 ** min($this->attempt, 30)));
        $this->attempt++;

        $fraction = $this->random instanceof Closure ? ($this->random)() : mt_rand() / mt_getrandmax();

        return round($step * (0.5 + 0.5 * max(0.0, min(1.0, $fraction))), 3);
    }

    public function reset(): void
    {
        $this->attempt = 0;
    }
}
