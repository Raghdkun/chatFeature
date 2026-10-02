<?php

namespace Tests\Support;

use App\Domain\Notifications\Contracts\DashboardVisibility;

/** Says who is looking at the dashboard, without any presence data. Nobody is, unless a test says so. */
final class FakeDashboardVisibility implements DashboardVisibility
{
    /** @var array<int, true> */
    private array $viewing = [];

    /** @var list<array{0: int, 1: int}> */
    public array $asked = [];

    public function lookingAtDashboard(int ...$userIds): void
    {
        foreach ($userIds as $userId) {
            $this->viewing[$userId] = true;
        }
    }

    public function isViewingDashboard(int $userId, int $withinSeconds = 60): bool
    {
        $this->asked[] = [$userId, $withinSeconds];

        return isset($this->viewing[$userId]);
    }
}
