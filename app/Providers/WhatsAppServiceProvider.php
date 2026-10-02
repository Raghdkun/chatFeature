<?php

namespace App\Providers;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Policies\WhatsAppPolicy;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Infrastructure\OpenWa\OpenWaHttpClient;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/**
 * OpenWA integration, admin-only inbox (P6).
 *
 * Owns the bindings of the WhatsApp context: the admin-only policy (decision P6-D1), signed media URLs and the OpenWA client (the
 * HTTP implementation in `app/Infrastructure/OpenWa`; `NullOpenWaClient` stays for code that must never reach a network and the test
 * suite binds `FakeOpenWaClient`). Keep bindings and boot logic for this bounded context here so parallel tracks never edit the same
 * provider.
 */
class WhatsAppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(OpenWaClient::class, OpenWaHttpClient::class);
        $this->app->bindIf(WaMediaUrls::class, SignedWaMediaUrls::class);
    }

    public function boot(): void
    {
        foreach ([WaChat::class, WaMessage::class, WhatsAppSession::class] as $model) {
            Gate::policy($model, WhatsAppPolicy::class);
        }
    }
}
