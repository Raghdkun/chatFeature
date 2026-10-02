<?php

namespace App\Domain\Notifications\Support;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Presence\PresenceService;
use App\Models\AgentPresence;

/**
 * The default {@see DashboardVisibility}: the presence heartbeat the dashboard already sends. Without a `visible` flag in it, a fresh
 * heartbeat of an agent whose status is `online` or `away` is the best evidence that a dashboard is open: it counts as looking at it
 * (the tab then notifies by itself, also from the background when the browser lets it). Presence (5A) binds a stricter implementation
 * that reads the `visible` flag, so a hidden tab no longer counts.
 */
final class PresenceDashboardVisibility implements DashboardVisibility
{
    public function __construct(private readonly PresenceService $presence) {}

    public function isViewingDashboard(int $userId, int $withinSeconds = 60): bool
    {
        $row = AgentPresence::query()->where('user_id', $userId)->first();

        if ($row === null || ! $this->presence->effectiveStatus($row)->isAvailable()) {
            return false;
        }

        return $row->last_heartbeat_at !== null && $row->last_heartbeat_at->gte(now()->subSeconds($withinSeconds));
    }
}
