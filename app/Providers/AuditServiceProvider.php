<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

/**
 * Audit log and transactional outbox (P1).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class AuditServiceProvider extends ServiceProvider
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
