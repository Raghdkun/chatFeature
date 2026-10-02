<?php

namespace App\Domain\Presence;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Presence\Contracts\PresenceStore;

/**
 * Is a member of staff looking at the dashboard right now? Answered from the presence store: the last heartbeat that REPORTED the tab
 * visible must be younger than the window. A hidden tab, a closed one, a sleeping laptop and a user who never signed in are not looking,
 * so the push listeners (5B) send the OS notification for them. Bound over the notifications default in `PresenceServiceProvider`.
 */
final class PresenceDashboardVisibility implements DashboardVisibility
{
    public function __construct(private readonly PresenceStore $store) {}

    public function isViewingDashboard(int $userId, int $withinSeconds = 60): bool
    {
        $now = now()->toImmutable();
        $record = $this->store->find($userId, $now);

        return $record?->visibleAt !== null && $record->visibleAt->gte($now->subSeconds($withinSeconds));
    }
}
