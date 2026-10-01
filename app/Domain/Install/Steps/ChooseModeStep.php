<?php

namespace App\Domain\Install\Steps;

use App\Auth\Enums\AuthMode;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;

/** Step 1: the auth mode is chosen once and locked after the wizard. */
final class ChooseModeStep implements InstallStep
{
    public function key(): string
    {
        return 'choose-mode';
    }

    public function label(): string
    {
        return 'Choose the authentication mode';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        $mode = AuthMode::tryFrom((string) $context->mode);

        if ($mode === null) {
            return StepResult::needsInput(['mode']);
        }

        if ($mode === AuthMode::Pizzasys && config('install.pizzasys_available') !== true) {
            return StepResult::failed('The pizzasys authentication mode is not available in this release yet.');
        }

        return StepResult::ok();
    }
}
