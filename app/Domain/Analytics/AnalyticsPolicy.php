<?php

namespace App\Domain\Analytics;

use App\Models\User;

/**
 * Who may read analytics (gates `analytics.*`, defined in `AnalyticsServiceProvider`; `Gate::before` already lets an active administrator
 * through, the explicit checks keep the rules readable and testable without it):
 *  - `view`: an active administrator or agent (an agent only gets their own numbers, which `AnalyticsQueryFactory` enforces);
 *  - `view-all`: the whole account: totals, other agents, breakdowns, the ratings' comments (administrators);
 *  - `whatsapp`: the WhatsApp numbers (administrators only, always);
 *  - `export`: the CSV export (administrators).
 * Visitors and guests are not users at all: the routes demand a staff session first.
 */
final class AnalyticsPolicy
{
    public function view(User $user): bool
    {
        return AnalyticsScope::roleOf($user) !== null;
    }

    public function viewAll(User $user): bool
    {
        return $user->is_active && $user->is_admin;
    }

    public function whatsapp(User $user): bool
    {
        return $this->viewAll($user);
    }

    public function export(User $user): bool
    {
        return $this->viewAll($user);
    }
}
