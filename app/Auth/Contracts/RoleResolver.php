<?php

namespace App\Auth\Contracts;

use App\Models\User;

interface RoleResolver
{
    /** Recompute and persist users.is_admin / users.is_agent for this user. */
    public function sync(User $user): void;
}
