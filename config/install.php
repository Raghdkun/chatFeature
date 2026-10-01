<?php

use App\Domain\Install\Steps\AppBasicsStep;
use App\Domain\Install\Steps\CheckEnvironmentStep;
use App\Domain\Install\Steps\ChooseModeStep;
use App\Domain\Install\Steps\ConfigurePizzasysStep;
use App\Domain\Install\Steps\CreateAdminStep;
use App\Domain\Install\Steps\RunMigrationsStep;
use App\Domain\Install\Steps\SeedDefaultsStep;
use App\Domain\Install\Steps\WriteLockStep;

/*
|--------------------------------------------------------------------------
| Install gate / setup wizard
|--------------------------------------------------------------------------
| Everything here must be readable WITHOUT a database: the wizard runs before
| the first migration. See docs/contracts/setup-wizard.md and install-steps.md.
*/
return [

    /*
     * Directory holding install-state.json, installed.lock and install.running.
     * null = storage/app. Tests point this at a temp directory.
     */
    'directory' => env('INSTALL_STATE_DIR'),

    /*
     * Optional override: APP_INSTALLED=true marks the app installed even without the lock file
     * (e.g. immutable infrastructure). The lock file stays the authoritative source.
     * APP_INSTALLED=false (explicit) also switches off the "testing env counts as installed" default.
     */
    'installed' => env('APP_INSTALLED'),

    /*
     * One-time takeover guard for the wizard (printed by `chat:bootstrap-secrets`).
     * Not required when APP_ENV=local. Never rendered into a response.
     */
    'setup_token' => env('SETUP_TOKEN'),

    /* Flipped on by P2 once the pizzasys wizard steps exist. */
    'pizzasys_available' => false,

    /*
     * Drivers forced while the app is not installed (no database / Redis / websocket server may
     * be assumed). The real `.env` drivers take over automatically once the lock exists.
     */
    'forced_drivers' => [
        'session.driver' => 'file',
        'cache.default' => 'file',
        'queue.default' => 'sync',
        'broadcasting.default' => 'null',
    ],

    /* Registered steps, in execution order. P2 replaces ConfigurePizzasysStep in place. */
    'steps' => [
        CheckEnvironmentStep::class,
        ChooseModeStep::class,
        ConfigurePizzasysStep::class,
        AppBasicsStep::class,
        RunMigrationsStep::class,
        SeedDefaultsStep::class,
        CreateAdminStep::class,
        WriteLockStep::class,
    ],

    /* Wizard defaults for the "basics" form. */
    'defaults' => [
        'timezone' => env('INSTALL_DEFAULT_TIMEZONE', 'UTC'),
        'idle_timeout_minutes' => 120,
    ],

    /*
     * Answers for the non-interactive `php artisan chat:install` (Docker provisioning / e2e).
     * Read through config so they keep working after `config:cache`.
     */
    'cli' => [
        'admin_name' => env('INSTALL_ADMIN_NAME'),
        'admin_email' => env('INSTALL_ADMIN_EMAIL'),
        'admin_password' => env('INSTALL_ADMIN_PASSWORD'),
        'app_name' => env('INSTALL_APP_NAME'),
        'app_url' => env('INSTALL_APP_URL'),
        'locale' => env('INSTALL_LOCALE'),
        'timezone' => env('INSTALL_TIMEZONE'),
        'idle_timeout_minutes' => env('INSTALL_IDLE_TIMEOUT_MINUTES'),
    ],
];
