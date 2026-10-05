<?php

namespace App\Domain\Presence\Listeners;

use App\Domain\Chat\Enums\SessionRevokeReason;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Presence\PresenceService;
use App\Models\User;
use Throwable;

/**
 * A staff member who is deactivated (or stops taking chats) is no longer reachable: their presence goes at once, so the Agents page, the
 * roster and the routing stop counting them without waiting for the 90 second window. (Routing and the widgets' availability already
 * ignore an inactive account; the lists did not.) Best effort: it never gets in the way of the change that caused it.
 */
final class GoOfflineWhenAccessEnds
{
    public function __construct(private readonly PresenceService $presence) {}

    public function handle(StaffSessionRevoked $event): void
    {
        if (! in_array($event->reason, [SessionRevokeReason::Deactivated, SessionRevokeReason::RoleRemoved], true)) {
            return;
        }

        $user = User::query()->find($event->userId);

        if ($user === null) {
            return;
        }

        try {
            $this->presence->signedOut($user);
        } catch (Throwable $exception) {
            report($exception);
        }
    }
}
