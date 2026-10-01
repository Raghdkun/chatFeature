<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

/**
 * Widget config, domains, greetings, embed delivery (P3).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class WidgetsServiceProvider extends ServiceProvider
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
