<?php

namespace App\Providers;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Policies\WhatsAppPolicy;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Infrastructure\OpenWa\OpenWaHttpClient;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\RateLimiter;
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

        $this->configureRateLimiting();
    }

    /**
     * The named limiters of the WhatsApp surface (numbers in `config/whatsapp.php`), all per minute.
     */
    private function configureRateLimiting(): void
    {
        // In front of the signature check: a flood of unsigned requests costs one lookup and one HMAC each, so it is bounded per
        // client network and per session (the string of the URL: the model is not bound yet when this runs).
        RateLimiter::for('wa-webhook', function (Request $request): array {
            $session = $request->route('session');
            $session = is_object($session) ? (string) ($session->ulid ?? '') : (string) $session;

            return [
                Limit::perMinute($this->limit('webhook.rate_limits.per_network', 600))->by('wa-hook-ip:'.ClientNetwork::bucket($request->ip())),
                Limit::perMinute($this->limit('webhook.rate_limits.per_session', 3000))->by('wa-hook:'.$session),
            ];
        });

        // The QR is polled every couple of seconds while the administrator looks at it; the connection test calls out to OpenWA.
        RateLimiter::for('wa-qr', fn (Request $request): Limit => Limit::perMinute($this->limit('admin_rate_limits.qr', 60))->by('wa-qr:'.($request->user()?->getAuthIdentifier() ?? ClientNetwork::bucket($request->ip()))));
        RateLimiter::for('wa-test', fn (Request $request): Limit => Limit::perMinute($this->limit('admin_rate_limits.test', 10))->by('wa-test:'.($request->user()?->getAuthIdentifier() ?? ClientNetwork::bucket($request->ip()))));
    }

    private function limit(string $key, int $default): int
    {
        return max(1, (int) config('whatsapp.'.$key, $default));
    }
}
