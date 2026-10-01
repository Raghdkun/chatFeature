<?php

namespace App\Domain\Install\Steps;

use App\Domain\Install\Actions\RecoverLockFromDatabase;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Str;
use Throwable;

/**
 * Step 3: `migrate --force`. The first step that touches the database.
 *
 * If the database already says `app.installed = true` while the lock file is missing, the lock is
 * restored here and the wizard ends (nothing else is re-run).
 */
final class RunMigrationsStep implements InstallStep
{
    public function __construct(private readonly RecoverLockFromDatabase $recoverLock) {}

    public function key(): string
    {
        return 'run-migrations';
    }

    public function label(): string
    {
        return 'Create the database tables';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        @set_time_limit(300);

        try {
            $exitCode = Artisan::call('migrate', ['--force' => true]);
        } catch (Throwable $exception) {
            report($exception);

            return StepResult::failed('Migrations failed: '.Str::limit(trim((string) strtok($exception->getMessage(), "\n")), 300));
        }

        if ($exitCode !== 0) {
            return StepResult::failed('Migrations failed: '.Str::limit(trim(Artisan::output()), 300));
        }

        if (($this->recoverLock)($context->state)) {
            return StepResult::ok('This database is already installed; the install lock was restored.');
        }

        return StepResult::ok();
    }
}
