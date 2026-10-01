<?php

namespace App\Providers;

use App\Domain\Catalog\Actions\EnsureGeneralCategory;
use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Catalog\Support\NullCategoryUsageChecker;
use Illuminate\Support\ServiceProvider;

/**
 * Support categories and agent-category assignment (P3).
 *
 * `CategoryUsageChecker` is the extension point P4 (Chat) rebinds to protect categories that active conversations use;
 * it is bound with `bindIf` so a binding registered earlier is kept.
 */
class CatalogServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bindIf(CategoryUsageChecker::class, NullCategoryUsageChecker::class);

        // Every installation starts with a "General" category (idempotent; runs in the wizard's seed-defaults step).
        $this->app->tag(EnsureGeneralCategory::class, 'install.seeders');
    }

    public function boot(): void
    {
        //
    }
}
