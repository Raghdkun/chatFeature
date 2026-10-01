<?php

namespace App\Domain\Install\Steps;

use App\Domain\Audit\AuditLogger;
use App\Domain\Install\Contracts\InstallStep;
use App\Domain\Install\InstallContext;
use App\Domain\Install\StepResult;
use App\Domain\Settings\SettingsRepository;
use App\Models\User;

/**
 * Step 7: sets the DB flag `app.installed`, then writes `installed.lock`.
 * After this every `/setup*` URL is 404 forever and the real `.env` drivers take over from the next
 * request on (the current request keeps the file/sync drivers it already resolved).
 *
 * The DB flag is written first on purpose: if the lock write fails, `run-migrations` can restore
 * the lock from the flag on the next attempt.
 */
final class WriteLockStep implements InstallStep
{
    public function __construct(
        private readonly SettingsRepository $settings,
        private readonly AuditLogger $audit,
    ) {}

    public function key(): string
    {
        return 'write-lock';
    }

    public function label(): string
    {
        return 'Finish the installation';
    }

    public function modes(): ?array
    {
        return null;
    }

    public function run(InstallContext $context): StepResult
    {
        if ($context->state->isInstalled()) {
            return StepResult::ok();
        }

        if ($context->mode === 'fortify' && ! User::query()->where('is_admin', true)->where('is_active', true)->exists()) {
            return StepResult::failed('No administrator exists yet. Create the first administrator before finishing.');
        }

        $this->settings->set('app.installed', true);
        $this->audit->record('install.completed', changes: ['mode' => $context->mode]);

        $context->state->mutate(function (array $state): array {
            if ($state['admin'] !== null) {
                $state['admin']['password_hash'] = null;
            }

            return $state;
        });

        $context->state->writeLock(['mode' => $context->mode]);

        return StepResult::ok();
    }
}
