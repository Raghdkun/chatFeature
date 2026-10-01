<?php

namespace App\Auth\Roles;

use App\Auth\Contracts\RoleResolver;
use App\Auth\Enums\UserRole;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Domain\Settings\SettingsRepository;
use App\Models\User;
use App\Models\UserExternalIdentity;

/**
 * Mode 2: chat roles are derived from the portal's roles/permissions of the ACTIVE environment and are not editable
 * locally.
 *
 *  - admin: a verified role is one of `super_roles`, OR the permissions contain `admin_permission`
 *    (`super-admin` carries no `chat.*` permission upstream, so the role name is checked explicitly);
 *  - agent: the permissions contain `agent_permission`; admins are agents as well.
 */
final class PizzasysRoleResolver implements RoleResolver
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuthEnvironmentRepository $environments,
    ) {}

    public function mapping(): RoleMapping
    {
        return RoleMapping::fromSettings($this->settings);
    }

    /**
     * @param  list<string>  $roles
     * @param  list<string>  $permissions
     */
    public function decide(array $roles, array $permissions, ?RoleMapping $mapping = null): RoleDecision
    {
        $mapping ??= $this->mapping();

        $isAdmin = array_intersect($roles, $mapping->superRoles) !== []
            || ($mapping->adminPermission !== '' && in_array($mapping->adminPermission, $permissions, true));

        $isAgent = $isAdmin || ($mapping->agentPermission !== '' && in_array($mapping->agentPermission, $permissions, true));

        return new RoleDecision($isAdmin, $isAgent);
    }

    public function decideFor(UserExternalIdentity $identity, ?RoleMapping $mapping = null): RoleDecision
    {
        return $this->decide($identity->roles, $identity->permissions, $mapping);
    }

    /**
     * Recompute and persist `users.is_admin` / `users.is_agent` from the live identity in the active environment. A
     * user without such an identity is left alone. The database allows at most one live identity per user and
     * environment; callers that just verified a specific identity should use {@see syncFromIdentity()} instead.
     */
    public function sync(User $user): void
    {
        $environment = $this->environments->active();

        if ($environment === null) {
            return;
        }

        $identity = UserExternalIdentity::query()
            ->where('user_id', $user->getKey())
            ->where('auth_environment_id', $environment->getKey())
            ->whereNull('deactivated_at')
            ->orderByDesc('last_verified_at')
            ->orderByDesc('id')
            ->first();

        if ($identity === null) {
            return;
        }

        $this->apply($user, $this->decideFor($identity));
    }

    /**
     * Persist the chat roles of exactly this identity (the one whose token was just verified), never of "whichever
     * identity the user happens to have". Nothing happens for an identity that is deactivated, belongs to another user
     * or lives in an environment that is not the active one.
     */
    public function syncFromIdentity(User $user, UserExternalIdentity $identity): void
    {
        $environment = $this->environments->active();

        if ($environment === null
            || $identity->isDeactivated()
            || $identity->user_id !== $user->getKey()
            || $identity->auth_environment_id !== $environment->getKey()) {
            return;
        }

        $this->apply($user, $this->decideFor($identity));
    }

    public function apply(User $user, RoleDecision $decision): void
    {
        $role = $decision->isAdmin ? UserRole::Admin : UserRole::Agent;

        if ($user->is_admin === $decision->isAdmin && $user->is_agent === $decision->isAgent && $user->role === $role) {
            return;
        }

        $user->forceFill(['is_admin' => $decision->isAdmin, 'is_agent' => $decision->isAgent, 'role' => $role])->save();
    }
}
