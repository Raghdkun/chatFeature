<?php

namespace App\Console\Commands;

use App\Auth\Pizzasys\Actions\SwitchActiveEnvironment;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use Illuminate\Console\Command;

/**
 * Break-glass: switch the active auth-portal environment without the dashboard and without any network call, for when
 * nobody can sign in any more (for example the testing portal was activated and went away).
 */
class ChatAuthSwitchEnv extends Command
{
    protected $signature = 'chat:auth:switch-env
        {env : The environment to activate: production or testing}
        {--force : Do not ask for confirmation}';

    protected $description = 'Switch the active auth-portal environment (production|testing) without the UI or network access';

    public function handle(
        InstallState $install,
        SettingsRepository $settings,
        AuthEnvironmentRepository $environments,
        SwitchActiveEnvironment $switch,
    ): int {
        $key = (string) $this->argument('env');

        if (! in_array($key, AuthEnvironment::KEYS, true)) {
            $this->components->error('Use "production" or "testing".');

            return self::FAILURE;
        }

        if (! $install->isInstalled() || $settings->string('auth.mode', 'fortify') !== 'pizzasys') {
            $this->components->error('This application is not installed in pizzasys mode; there is nothing to switch.');

            return self::FAILURE;
        }

        $target = $environments->find($key);

        if ($target === null || $target->endpoint() === null) {
            $this->components->error("The {$key} environment is not configured (or its service token cannot be decrypted).");

            return self::FAILURE;
        }

        if ($environments->activeKey() === $key) {
            $this->components->info("The {$key} environment is already active.");

            return self::SUCCESS;
        }

        if (! $this->option('force') && ! $this->confirm("Activate \"{$key}\" and sign every other user out?", false)) {
            $this->components->warn('Cancelled.');

            return self::FAILURE;
        }

        $revoked = $switch($target, null, 'cli');

        $this->components->info("Active environment is now \"{$key}\". Revoked {$revoked} portal session(s); the NATS consumer will reconnect.");

        return self::SUCCESS;
    }
}
