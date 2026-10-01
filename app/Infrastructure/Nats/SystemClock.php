<?php

namespace App\Infrastructure\Nats;

use App\Infrastructure\Nats\Contracts\Clock;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Date;

final class SystemClock implements Clock
{
    public function now(): CarbonImmutable
    {
        return CarbonImmutable::instance(Date::now());
    }

    public function sleep(float $seconds): void
    {
        if ($seconds > 0) {
            usleep((int) round($seconds * 1_000_000));
        }
    }
}
