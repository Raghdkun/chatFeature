<?php

namespace App\Infrastructure\Nats\Handlers;

use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\EventOutcome;

/**
 * Reacts to one kind of pizzasys event. Register new ones on the EventRouter; a handler must be idempotent
 * (an event can be redelivered after a failure) and must never log the event payload.
 */
interface Handler
{
    public function handle(CloudEvent $event): EventOutcome;
}
