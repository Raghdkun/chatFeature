<?php

namespace App\Infrastructure\Nats\Handlers;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;

/**
 * The event changes (or may change) one user's roles/permissions/profile: mark that identity stale. When the
 * event does not name a resolvable user the safe fallback is to mark everyone stale.
 */
final readonly class FlushIdentityHandler implements Handler
{
    public function __construct(private IdentityInvalidator $invalidator) {}

    public function handle(CloudEvent $event): EventOutcome
    {
        $externalId = $event->externalUserId();

        if ($externalId === null) {
            $this->invalidator->flushAll();

            return EventOutcome::FlushedAll;
        }

        $this->invalidator->flushForExternalId($externalId);

        return EventOutcome::FlushedUser;
    }
}
