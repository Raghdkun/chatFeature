<?php

namespace App\Providers;

use App\Domain\Install\InstallLock;
use App\Domain\Install\InstallRunner;
use App\Domain\Install\SetupTokenManager;
use App\Domain\Install\Support\EnvironmentChecker;
use Illuminate\Support\ServiceProvider;

/**
 * Install gate, setup wizard, install lock (P1).
 *
 * InstallState and the pre-install driver override are bound earlier, in InstallAwareConfigProvider
 * (first in bootstrap/providers.php). The wizard steps are listed in config/install.php.
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class InstallServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(InstallLock::class);
        $this->app->singleton(SetupTokenManager::class);
        $this->app->singleton(EnvironmentChecker::class);
        $this->app->singleton(InstallRunner::class);
    }

    public function boot(): void
    {
        //
    }
}
