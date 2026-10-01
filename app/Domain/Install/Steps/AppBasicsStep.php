<?php

namespace App\Domain\Install\Steps;

use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;

/**
 * Step 6 of the contract table: app name/URL, locale, timezone, idle timeout.
 *
 * The answers are stored in install-state.json by the wizard form (or by `chat:install`) and are
 * written to the settings table by `seed-defaults`, because the database does not exist yet when
 * the form is posted. This step therefore only verifies that they were given, and runs before
 * `run-migrations` (see docs/contracts/install-steps.md, "Notes").
 */
final class AppBasicsStep implements InstallStep
{
    public function key(): string
    {
        return 'app-basics';
    }

    public function label(): string
    {
        return 'App basics';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        return $context->basics === null ? StepResult::needsInput(['basics']) : StepResult::ok();
    }
}
