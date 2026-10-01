<?php

namespace App\Domain\Install\Contracts;

use App\Domain\Install\InstallContext;

/**
 * Hook for bounded contexts that need rows on a fresh install. Tag implementations with
 * `install.seeders` in the context's service provider; `seed-defaults` runs them after the
 * default settings are written. Implementations MUST be idempotent.
 *
 * TODO(P3): Catalog seeds the "General" category, Widgets seeds a disabled sample widget.
 */
interface SeedsDefaults
{
    public function seed(InstallContext $context): void;
}
