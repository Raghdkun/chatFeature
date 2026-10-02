<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;

/**
 * The outcome of a presence write or a sweep check: the effective status clients had been told (`before`) and the one that holds now
 * (`after`). Only the caller that moved the announced status gets `changed()`, so one real change is dispatched once.
 */
final readonly class PresenceTransition
{
    public function __construct(
        public int $userId,
        public PresenceStatus $before,
        public PresenceStatus $after,
        public ?PresenceRecord $record = null,
    ) {}

    public function changed(): bool
    {
        return $this->before !== $this->after;
    }

    /** Whether the agent started or stopped being reachable (`online` / `away` against `offline`). */
    public function reachabilityChanged(): bool
    {
        return $this->before->isAvailable() !== $this->after->isAvailable();
    }
}
