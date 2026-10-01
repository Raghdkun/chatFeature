<?php

namespace App\Console\Commands;

use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Development helper: forget the installation so the wizard can be run again. Destroys the
 * whole configured database, so it refuses to run anywhere but APP_ENV=local.
 */
class ChatInstallReset extends Command
{
    protected $signature = 'chat:install:reset
        {--force : Do not ask for confirmation}';

    protected $description = 'Local only: delete the install state and lock and wipe the database';

    public function handle(InstallState $install, SettingsRepository $settings): int
    {
        if (! $this->laravel->environment('local')) {
            $this->components->error('chat:install:reset only runs when APP_ENV=local (it wipes the whole database).');

            return self::FAILURE;
        }

        $database = (string) DB::connection()->getDatabaseName();

        if (! $this->option('force') && ! $this->confirm("This wipes every table in the database [{$database}] and removes the install lock. Continue?")) {
            return self::FAILURE;
        }

        try {
            $settings->forget();
        } catch (Throwable $exception) {
            $this->components->warn('Could not clear the settings cache: '.$exception->getMessage());
        }

        Artisan::call('db:wipe', ['--force' => true]);
        $install->reset();

        $this->components->info("Wiped database [{$database}] and removed the install state and lock. Open /setup to install again.");

        return self::SUCCESS;
    }
}
