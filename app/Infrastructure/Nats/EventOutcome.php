<?php

namespace App\Infrastructure\Nats;

/**
 * What a handled event did; stored in `processed_events.outcome`.
 */
enum EventOutcome: string
{
    case FlushedUser = 'flush_user';
    case FlushedAll = 'flush_all';
    case DeactivatedUser = 'deactivate_user';
    case Noop = 'noop';
    case Unknown = 'unknown';
    case Duplicate = 'duplicate';
}
