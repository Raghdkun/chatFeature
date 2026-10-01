<?php

namespace App\Providers;

use App\Domain\Widgets\Actions\SeedSampleWidget;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Domain\Widgets\Embed\LoaderBundle;
use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\NullPresenceReader;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Widget config, domains, greetings, embed delivery (P3).
 *
 * `PresenceReader` is the extension point P5 (Presence) rebinds; it is bound with `bindIf` so a binding registered
 * earlier is kept. The `public-config` rate limiter protects the loader script, the iframe pages and the public
 * config/availability endpoints.
 */
class WidgetsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(OriginMatcher::class);
        $this->app->bindIf(PresenceReader::class, NullPresenceReader::class);
        $this->app->singleton(LoaderBundle::class, fn (): LoaderBundle => new LoaderBundle(public_path('widget/v1/loader.js')));

        // A fresh installation ships one disabled sample widget (idempotent; runs in the wizard's seed-defaults step).
        $this->app->tag(SeedSampleWidget::class, 'install.seeders');
    }

    public function boot(): void
    {
        RateLimiter::for('public-config', fn (Request $request): array => [
            // Generous per address (offices share one), with a ceiling per widget.
            Limit::perMinute(300)->by('config:'.$request->ip().':'.$request->route('key')),
            Limit::perMinute(6000)->by('config:'.$request->route('key')),
        ]);
    }
}
