<?php

namespace App\Domain\Notifications\Contracts;

/**
 * Is a member of staff looking at the dashboard right now? The push listeners ask before every OS notification: an agent who has the
 * inbox open and in front of them already gets the in-page toast and sound (P5-D5), so a push on top would double the alert.
 *
 * The default binding (`PresenceDashboardVisibility`) answers from the presence heartbeat the dashboard already sends. Presence (5A)
 * replaces it with one that reads the heartbeat's `visible` flag: bind it in `PresenceServiceProvider::register()` with `bind()`
 * (not `bindIf`) and it wins over the default, which is only registered when nothing else has been.
 */
interface DashboardVisibility
{
    /**
     * True when the user's dashboard sent a heartbeat REPORTING IT IS VISIBLE (tab in front, window not minimised) within the last
     * `$withinSeconds`; false for a hidden tab, a closed one, a sleeping laptop, or a user who never signed in.
     */
    public function isViewingDashboard(int $userId, int $withinSeconds = 60): bool;
}
