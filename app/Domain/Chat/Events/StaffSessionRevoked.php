<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\SessionRevokeReason;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A staff member's session ended (role removed, account deactivated, auth portal revoked it). Dispatched by the auth layer
 * (NATS consumer, session validity middleware); consumed by 4B: `session.revoked` to `private-staff.{userId}`
 * (`SessionRevokedPayload`, delivered immediately).
 */
final class StaffSessionRevoked implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly int $userId,
        public readonly SessionRevokeReason $reason,
    ) {}
}
