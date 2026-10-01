<?php

namespace App\Providers;

use App\Domain\Presence\AvailableAgents;
use App\Domain\Presence\DatabasePresenceReader;
use App\Domain\Presence\PresenceService;
use App\Domain\Widgets\Contracts\PresenceReader;
use Illuminate\Support\ServiceProvider;

/**
 * Agent presence and availability (minimal in P4, Redis / auto-away / sweep in P5).
 *
 * Binds the real `PresenceReader` that feeds the public availability endpoint (this provider is registered before the Widgets
 * one, whose `bindIf` default for it - nobody online - then stays unused). Keep bindings and boot logic for this bounded
 * context here so parallel tracks never edit the same provider.
 */
class PresenceServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(AvailableAgents::class);
        $this->app->singleton(PresenceService::class);
        $this->app->bind(PresenceReader::class, DatabasePresenceReader::class);
    }

    public function boot(): void
    {
        //
    }
}
