<?php

namespace App\Providers;

use App\Domain\Widgets\Actions\SeedSampleWidget;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Domain\Widgets\Embed\LoaderBundle;
use App\Domain\Widgets\Identity\IdentityTokenVerifier;
use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Domain\Widgets\Support\NullPresenceReader;
use App\Domain\Widgets\Support\WidgetCache;
use App\Http\Middleware\Widgets\ThrottlePublicNetwork;
use App\Http\Middleware\Widgets\ThrottlePublicWidget;
use App\Models\Widget;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Widget config, domains, greetings, embed delivery (P3).
 *
 * `PresenceReader` is the extension point P5 (Presence) rebinds; it is bound with `bindIf` so a binding registered
 * earlier is kept.
 *
 * Two rate limiters protect the public endpoints (numbers in `config/chat.php`, `rate_limits`):
 * - `public-config` (ThrottlePublicNetwork): per client network (IPv4 address / IPv6 /64) across ALL widget keys,
 *   applied before the key is even looked up (loader script, iframe pages, config/availability API);
 * - `public-config-widget` (ThrottlePublicWidget): per (network, key) and per (key, allowed origin), applied after the
 *   origin check, so only requests of allowed origins use up a widget's budget.
 */
class WidgetsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(OriginMatcher::class);
        $this->app->bindIf(PresenceReader::class, NullPresenceReader::class);
        $this->app->singleton(LoaderBundle::class, fn (): LoaderBundle => new LoaderBundle(public_path('widget/v1/loader.js')));
        $this->app->singleton(IdentityTokenVerifier::class, fn ($app): IdentityTokenVerifier => new IdentityTokenVerifier(
            $app->make(Repository::class),
            (int) config('chat.identity.max_lifetime_seconds', IdentityTokenVerifier::MAX_LIFETIME_SECONDS),
        ));

        // A fresh installation ships one disabled sample widget (idempotent; runs in the wizard's seed-defaults step).
        $this->app->tag(SeedSampleWidget::class, 'install.seeders');
    }

    public function boot(): void
    {
        RateLimiter::for(ThrottlePublicNetwork::LIMITER, fn (Request $request): Limit => Limit::perMinute((int) config('chat.rate_limits.public_ip', 600))
            ->by('config-ip:'.ClientNetwork::bucket($request->ip())));

        RateLimiter::for(ThrottlePublicWidget::LIMITER, function (Request $request): array {
            $key = (string) $request->route('key');
            $origin = (string) $request->attributes->get('widget_origin', '-');

            return [
                Limit::perMinute((int) config('chat.rate_limits.public_widget_ip', 300))->by('config-ip-key:'.ClientNetwork::bucket($request->ip()).':'.$key),
                Limit::perMinute((int) config('chat.rate_limits.public_widget_origin', 6000))->by('config-widget:'.$key.':'.$origin),
            ];
        });

        // A key is only "unknown" until a widget is created with it.
        Widget::created(fn (Widget $widget) => $this->app->make(WidgetCache::class)->forgetUnknownKey($widget->public_key));
    }
}
