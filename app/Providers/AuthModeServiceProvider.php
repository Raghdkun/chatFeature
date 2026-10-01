<?php

namespace App\Providers;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Contracts\RoleResolver;
use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Pizzasys\DatabaseNatsSettingsProvider;
use App\Auth\Pizzasys\ExternalIdentityInvalidator;
use App\Auth\Pizzasys\Listeners\CloseExternalSession;
use App\Auth\Pizzasys\Listeners\OpenExternalSession;
use App\Auth\Pizzasys\PendingPortalLogins;
use App\Auth\Roles\LocalRoleResolver;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Console\Commands\ChatAuthPruneSessions;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Models\User;
use Illuminate\Auth\Events\Login;
use Illuminate\Auth\Events\Logout;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
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

        // Mode 1 derives roles from users.role (editable); mode 2 from the portal's roles/permissions (not editable).
        $this->app->bind(RoleResolver::class, fn ($app): RoleResolver => settings('auth.mode', 'fortify') === 'pizzasys'
            ? $app->make(PizzasysRoleResolver::class)
            : $app->make(LocalRoleResolver::class));

        // Hand-over between PizzasysDriver::attempt() and the Login listener; never outlives the request.
        $this->app->scoped(PendingPortalLogins::class);

        // Consumed by the NATS event handlers (track 2B).
        $this->app->bind(IdentityInvalidator::class, ExternalIdentityInvalidator::class);
    }

    public function boot(): void
    {
        // One super-admin rule for every policy and gate: active admins may do anything.
        // Returning null (not false) leaves the decision to the normal policies for everyone else.
        Gate::before(fn (?Authenticatable $user): ?bool => $user instanceof User && $user->is_admin && $user->is_active ? true : null);

        // Bound in boot() so this database-backed provider wins over a config-backed default registered by another provider.
        $this->app->bind(NatsSettingsProvider::class, DatabaseNatsSettingsProvider::class);

        $this->configureRateLimiting();

        // A portal login becomes a session when the guard logs the user in, and ends with the guard's logout.
        Event::listen(Login::class, [OpenExternalSession::class, 'handle']);
        Event::listen(Logout::class, [CloseExternalSession::class, 'handle']);

        // Sessions of people who just closed the tab would otherwise keep a never-expiring upstream token alive.
        $this->callAfterResolving(Schedule::class, function (Schedule $schedule): void {
            $schedule->command(ChatAuthPruneSessions::class)->dailyAt('03:30')->onOneServer()->withoutOverlapping();
        });
    }

    /**
     * Named limiters, so the portal endpoints do not share one counter with every other anonymous `throttle:N,M` route
     * (the unnamed form keys all of them on the same client signature).
     */
    private function configureRateLimiting(): void
    {
        RateLimiter::for('setup-portal-save', fn (Request $request): Limit => Limit::perMinute(30)->by($request->ip() ?? 'unknown'));
        RateLimiter::for('setup-portal-test', fn (Request $request): Limit => Limit::perMinute(10)->by($request->ip() ?? 'unknown'));
        // The portal administrator's password is typed here: five tries a minute per client.
        RateLimiter::for('setup-portal-admin', fn (Request $request): Limit => Limit::perMinute(5)->by($request->ip() ?? 'unknown'));

        RateLimiter::for('auth-environment-test', fn (Request $request): Limit => Limit::perMinute(10)->by((string) ($request->user()?->getAuthIdentifier() ?? $request->ip())));
        RateLimiter::for('auth-environment-activate', fn (Request $request): Limit => Limit::perMinute(5)->by((string) ($request->user()?->getAuthIdentifier() ?? $request->ip())));
    }
}
