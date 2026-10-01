<?php

namespace App\Providers;

use App\Domain\Settings\DefaultSettings;
use App\Domain\Settings\SettingsRegistry;
use App\Domain\Settings\SettingsRepository;
use Illuminate\Support\ServiceProvider;

/**
 * Typed settings store and the `settings()` helper (P1).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class SettingsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        require_once app_path('Domain/Settings/helpers.php');

        $this->app->singleton(SettingsRegistry::class, function (): SettingsRegistry {
            $registry = new SettingsRegistry;
            $registry->define(...DefaultSettings::definitions());

            return $registry;
        });

        $this->app->singleton(SettingsRepository::class);
    }

    public function boot(): void
    {
        //
    }
}
