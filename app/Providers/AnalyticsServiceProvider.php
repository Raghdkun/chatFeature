<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

/**
 * Read models, rollups, exports (P7).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class AnalyticsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        //
    }
}
