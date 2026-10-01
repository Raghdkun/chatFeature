<?php

namespace App\Providers;

use App\Domain\Catalog\Actions\EnsureGeneralCategory;
use Illuminate\Support\ServiceProvider;

/**
 * Support categories and agent-category assignment (P3).
 *
 * `CategoryUsageChecker` (can a category be deleted?) is implemented and bound by the Chat context
 * (`ChatServiceProvider`: queued / active conversations keep a category alive).
 */
class CatalogServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Every installation starts with a "General" category (idempotent; runs in the wizard's seed-defaults step).
        $this->app->tag(EnsureGeneralCategory::class, 'install.seeders');
    }

    public function boot(): void
    {
        //
    }
}
