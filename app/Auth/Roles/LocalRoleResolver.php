<?php

namespace App\Auth\Roles;

use App\Auth\Contracts\RoleResolver;
use App\Auth\Enums\UserRole;
use App\Models\User;

/**
 * Mode 1 (Fortify): roles are edited locally. `users.role` is the source of truth.
 *
 * - role `admin` => is_admin; whether an admin also takes chats stays their own `is_agent` choice.
 * - role `agent` => is_agent, never admin.
 */
final class LocalRoleResolver implements RoleResolver
{
    public function sync(User $user): void
    {
        $isAdmin = $user->role === UserRole::Admin;
        $isAgent = $user->role === UserRole::Agent ? true : $user->is_agent;

        if ($user->is_admin === $isAdmin && $user->is_agent === $isAgent) {
            return;
        }

        $user->forceFill(['is_admin' => $isAdmin, 'is_agent' => $isAgent])->save();
    }
}
