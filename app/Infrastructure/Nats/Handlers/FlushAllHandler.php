<?php

namespace App\Infrastructure\Nats\Handlers;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;

/**
 * Role/permission/store/hierarchy changes affect an unknown set of users: mark every identity stale.
 */
final readonly class FlushAllHandler implements Handler
{
    public function __construct(private IdentityInvalidator $invalidator) {}

    public function handle(CloudEvent $event): EventOutcome
    {
        $this->invalidator->flushAll();

        return EventOutcome::FlushedAll;
    }
}
