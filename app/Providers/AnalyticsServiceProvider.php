<?php

namespace App\Providers;

use App\Domain\Analytics\AnalyticsPolicy;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/**
 * Read models, rollups, exports (P7): the gates `analytics.view`, `analytics.view-all`, `analytics.whatsapp`, `analytics.export`
 * (docs/analytics.md, "Permissions"). The rollup collectors and reports are plain classes resolved by the container.
 */
class AnalyticsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        Gate::define('analytics.view', [AnalyticsPolicy::class, 'view']);
        Gate::define('analytics.view-all', [AnalyticsPolicy::class, 'viewAll']);
        Gate::define('analytics.whatsapp', [AnalyticsPolicy::class, 'whatsapp']);
        Gate::define('analytics.export', [AnalyticsPolicy::class, 'export']);
    }
}
