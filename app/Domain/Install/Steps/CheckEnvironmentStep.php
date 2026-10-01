<?php

namespace App\Domain\Install\Steps;

use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Install\Support\EnvironmentChecker;

/** Step 0: PHP extensions, writable storage, APP_KEY, database connection, optional Redis. */
final class CheckEnvironmentStep implements InstallStep
{
    public function __construct(private readonly EnvironmentChecker $checker) {}

    public function key(): string
    {
        return 'check-environment';
    }

    public function label(): string
    {
        return 'Check the environment';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        $checks = $this->checker->run();

        if (EnvironmentChecker::passes($checks)) {
            return StepResult::ok();
        }

        $problems = [];
        foreach ($checks as $check) {
            if (! $check->ok && ! $check->optional) {
                $problems[] = $check->message ?? $check->label;
            }
        }

        return StepResult::failed(implode(' ', $problems));
    }
}
