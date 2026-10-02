<?php

namespace App\Providers;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Policies\WhatsAppPolicy;
use App\Domain\WhatsApp\Support\NullOpenWaClient;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/**
 * OpenWA integration, admin-only inbox (P6).
 *
 * Owns the bindings of the WhatsApp context: the admin-only policy (decision P6-D1), signed media URLs and the OpenWA client.
 * The client defaults to `NullOpenWaClient` (every call throws `OpenWaUnavailable`) so nothing reaches a network by accident; the
 * HTTP implementation of the WhatsApp backend track replaces that `bindIf` with a real `bind` here. Keep bindings and boot logic for
 * this bounded context here so parallel tracks never edit the same provider.
 */
class WhatsAppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bindIf(OpenWaClient::class, NullOpenWaClient::class);
        $this->app->bindIf(WaMediaUrls::class, SignedWaMediaUrls::class);
    }

    public function boot(): void
    {
        foreach ([WaChat::class, WaMessage::class, WhatsAppSession::class] as $model) {
            Gate::policy($model, WhatsAppPolicy::class);
        }
    }
}
