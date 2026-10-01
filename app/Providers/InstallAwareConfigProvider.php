<?php

namespace App\Providers;

use App\Domain\Install\InstallAwareConfig;
use App\Domain\Install\InstallState;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Support\ServiceProvider;

/**
 * MUST be the first entry of bootstrap/providers.php.
 *
 * Until the install lock exists there may be no database, Redis or websocket server, so session,
 * cache, queue and broadcasting are forced to file / file / sync / null. Once the lock exists this
 * provider does nothing and the drivers from `.env` take over automatically (`.env` is never rewritten).
 */
class InstallAwareConfigProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(InstallState::class, function (Application $app): InstallState {
            $directory = config('install.directory');

            // The test suite runs against an already-installed app; tests opt out with InstallState::fake().
            $assumeInstalled = $app->environment('testing') && config('install.installed') !== false;

            return new InstallState(
                is_string($directory) && $directory !== '' ? $directory : storage_path('app'),
                $assumeInstalled ? true : null,
            );
        });

        $this->app->singleton(InstallAwareConfig::class);

        $this->app->make(InstallAwareConfig::class)->apply();
    }
}
