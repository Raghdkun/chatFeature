<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\PresenceStatus;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A staff member's presence status changed. Dispatched by the presence service (P5; P4's `PUT /me/presence`);
 * consumed by 4B: `presence.changed` on `presence-staff` (`PresenceChangedPayload`).
 */
final class PresenceChanged implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly int $userId,
        public readonly PresenceStatus $status,
    ) {}
}
