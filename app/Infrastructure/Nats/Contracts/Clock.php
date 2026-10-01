<?php

namespace App\Infrastructure\Nats\Contracts;

use App\Infrastructure\Nats\SystemClock;
use Carbon\CarbonImmutable;
use Illuminate\Container\Attributes\Bind;

/**
 * Time source and sleeper of the consumer loop (replaced by a virtual clock in tests).
 */
#[Bind(SystemClock::class)]
interface Clock
{
    public function now(): CarbonImmutable;

    public function sleep(float $seconds): void;
}
