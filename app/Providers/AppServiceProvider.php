<?php

namespace App\Providers;

use App\Http\Middleware\PreventRequestForgeryWithoutCookieForApi;
use App\Http\Middleware\StartSessionReadOnlyForApi;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Session\Middleware\StartSession;
use Illuminate\Session\SessionManager;
use Illuminate\Support\Facades\Date;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->registerReadOnlyApiSessions();
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        $this->configureDefaults();
        $this->configureTrustedProxies();
    }

    /**
     * The dashboard's background requests (`api/*`, `POST /broadcasting/auth`) load the session but never save it
     * (`StartSessionReadOnlyForApi`) and do not answer with an XSRF cookie (`PreventRequestForgeryWithoutCookieForApi`). Both the
     * `web` group and Sanctum's stateful pipeline resolve the framework classes from the container, so one binding each covers them;
     * any other request behaves exactly like the original.
     */
    protected function registerReadOnlyApiSessions(): void
    {
        $this->app->singleton(StartSession::class, fn (Application $app): StartSessionReadOnlyForApi => new StartSessionReadOnlyForApi(
            $app->make(SessionManager::class),
            fn () => $app->make(CacheFactory::class),
        ));
        $this->app->bind(PreventRequestForgery::class, PreventRequestForgeryWithoutCookieForApi::class);
    }

    /**
     * Configure default behaviors for production-ready applications.
     */
    protected function configureDefaults(): void
    {
        Date::use(CarbonImmutable::class);

        DB::prohibitDestructiveCommands(
            app()->isProduction(),
        );

        Password::defaults(fn (): ?Password => app()->isProduction()
            ? Password::min(12)
                ->mixedCase()
                ->letters()
                ->numbers()
                ->symbols()
                ->uncompromised()
            : null,
        );
    }

    /**
     * Honour X-Forwarded-For/Proto/Host from the configured reverse proxies only (Caddy in production).
     */
    protected function configureTrustedProxies(): void
    {
        $proxies = config('chat.trusted_proxies');

        if (is_string($proxies) && trim($proxies) !== '') {
            TrustProxies::at(trim($proxies) === '*' ? '*' : array_map('trim', explode(',', $proxies)));
        }
    }
}
