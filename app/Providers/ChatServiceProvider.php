<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;

/**
 * Conversation lifecycle, messages, attachments, ratings (P4).
 *
 * Owned by the phase noted above; keep bindings and boot logic for this
 * bounded context here so parallel tracks never edit the same provider.
 */
class ChatServiceProvider extends ServiceProvider
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
