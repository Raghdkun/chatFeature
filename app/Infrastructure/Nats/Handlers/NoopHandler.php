<?php

namespace App\Infrastructure\Nats\Handlers;

use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;

/**
 * Known events that cannot change anything we cache (e.g. a brand-new role nobody holds yet).
 */
final readonly class NoopHandler implements Handler
{
    public function handle(CloudEvent $event): EventOutcome
    {
        return EventOutcome::Noop;
    }
}
