<?php

namespace App\Providers;

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
        //
    }

    public function boot(): void
    {
        //
    }
}
