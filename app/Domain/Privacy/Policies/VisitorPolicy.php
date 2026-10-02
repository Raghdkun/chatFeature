<?php

namespace App\Domain\Privacy\Policies;

use App\Models\User;

/**
 * Who may erase a visitor and export what is held about them (data-subject requests): active administrators only. `Gate::before` lets an
 * administrator through every ability; this policy is what an agent, a deactivated administrator or any other user is asked, and the
 * actions ask it again so they refuse a caller that did not come through the admin middleware.
 */
final class VisitorPolicy
{
    public function erase(User $user): bool
    {
        return $user->is_active && $user->is_admin;
    }

    public function export(User $user): bool
    {
        return $user->is_active && $user->is_admin;
    }
}
