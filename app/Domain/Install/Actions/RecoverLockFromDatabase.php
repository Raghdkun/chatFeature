<?php

namespace App\Domain\Install\Actions;

use App\Domain\Install\InstallState;
use App\Models\Setting;

/**
 * "Only the DB flag exists": the database says `app.installed = true` but `installed.lock` is gone
 * (fresh container, wiped storage volume). Restore the lock instead of re-running the wizard.
 *
 * Reads the database, so it may only run after `run-migrations` succeeded.
 */
final class RecoverLockFromDatabase
{
    public function __invoke(InstallState $state): bool
    {
        if ($state->isInstalled()) {
            return false;
        }

        $flag = Setting::query()
            ->where('workspace_key', 0)
            ->where('key', 'app.installed')
            ->value('value');

        if (! is_string($flag) || json_decode($flag, true) !== true) {
            return false;
        }

        $state->writeLock(['recovered' => true]);

        return true;
    }
}
