<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

/**
 * Push channel adapters: web push now, FCM later (P5).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class NotificationsServiceProvider extends ServiceProvider
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
