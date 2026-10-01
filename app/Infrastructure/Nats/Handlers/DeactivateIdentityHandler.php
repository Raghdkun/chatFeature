<?php

namespace App\Infrastructure\Nats\Handlers;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;

/**
 * `user.deleted`: upstream removed the account, so revoke every session of that identity. Without a user id there is
 * nothing to deactivate; fall back to marking everyone stale (they re-verify upstream and the deleted one fails).
 */
final readonly class DeactivateIdentityHandler implements Handler
{
    public function __construct(private IdentityInvalidator $invalidator) {}

    public function handle(CloudEvent $event): EventOutcome
    {
        $externalId = $event->externalUserId();

        if ($externalId === null) {
            $this->invalidator->flushAll();

            return EventOutcome::FlushedAll;
        }

        $this->invalidator->deactivateExternalId($externalId);

        return EventOutcome::DeactivatedUser;
    }
}
