<?php

namespace App\Domain\Install\Contracts;

use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;

/**
 * One idempotent, resumable step of the setup wizard (docs/contracts/install-steps.md).
 */
interface InstallStep
{
    /** Stable machine id, e.g. 'check-environment', 'run-migrations'. Used as the route segment. */
    public function key(): string;

    /** Human label for the progress UI (translated by the caller). */
    public function label(): string;

    /**
     * Only run for these modes; null = all modes.
     *
     * @return list<string>|null `['fortify']`, `['pizzasys']` or null.
     */
    public function modes(): ?array;

    /** Safe to call again after a failure or partial run. Must not require the DB unless it runs after migrate. */
    public function run(InstallContext $context): StepResult;
}
