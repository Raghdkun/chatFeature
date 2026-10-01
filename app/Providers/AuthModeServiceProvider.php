<?php

namespace App\Providers;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Contracts\RoleResolver;
use App\Auth\Roles\LocalRoleResolver;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/**
 * Pluggable auth drivers: Fortify and pizzasys (P1/P2).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class AuthModeServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AuthModeManager::class);

        $this->app->bind(AuthDriver::class, fn ($app): AuthDriver => $app->make(AuthModeManager::class)->activeDriver());

        // Mode 1 derives roles from users.role. P2 makes this mode-aware (PizzasysRoleResolver).
        $this->app->bind(RoleResolver::class, LocalRoleResolver::class);
    }

    public function boot(): void
    {
        // One super-admin rule for every policy and gate: active admins may do anything.
        // Returning null (not false) leaves the decision to the normal policies for everyone else.
        Gate::before(fn (?Authenticatable $user): ?bool => $user instanceof User && $user->is_admin && $user->is_active ? true : null);
    }
}
