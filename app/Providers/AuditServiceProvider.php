<?php

namespace App\Providers;

use App\Domain\Audit\AuditLogger;
use Illuminate\Support\ServiceProvider;

/**
 * Audit log (P1).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class AuditServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AuditLogger::class);
    }

    public function boot(): void
    {
        //
    }
}
