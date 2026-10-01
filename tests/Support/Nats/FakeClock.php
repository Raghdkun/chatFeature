<?php

namespace Tests\Support\Nats;

use App\Infrastructure\Nats\Contracts\Clock;
use Carbon\CarbonImmutable;
use Closure;

/**
 * Virtual time: sleeping advances the clock instantly and is recorded.
 */
final class FakeClock implements Clock
{
    /** @var list<float> */
    public array $sleeps = [];

    /** @var (Closure(float, self): void)|null runs after every sleep */
    public ?Closure $onSleep = null;

    public function __construct(private CarbonImmutable $now) {}

    public function now(): CarbonImmutable
    {
        return $this->now;
    }

    public function sleep(float $seconds): void
    {
        $this->sleeps[] = $seconds;
        $this->advance($seconds);

        if ($this->onSleep instanceof Closure) {
            ($this->onSleep)($seconds, $this);
        }
    }

    public function advance(float $seconds): void
    {
        $this->now = $this->now->addMicroseconds((int) round($seconds * 1_000_000));
    }

    public function totalSlept(): float
    {
        return array_sum($this->sleeps);
    }
}
