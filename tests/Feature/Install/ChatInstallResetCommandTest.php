<?php

namespace Tests\Feature\Install;

use Illuminate\Support\Facades\Schema;

class ChatInstallResetCommandTest extends InstallTestCase
{
    public function test_it_refuses_to_run_outside_the_local_environment(): void
    {
        $this->assertSame('testing', $this->app->environment());
        $this->install->writeLock();

        $this->artisan('chat:install:reset', ['--force' => true])
            ->expectsOutputToContain('APP_ENV=local')
            ->assertExitCode(1);

        $this->assertTrue($this->install->isInstalled(), 'the lock must survive a refused reset');
    }

    public function test_it_refuses_in_production_too(): void
    {
        $this->app->detectEnvironment(fn () => 'production');
        $this->install->writeLock();

        $this->artisan('chat:install:reset', ['--force' => true])->assertExitCode(1);

        $this->assertTrue($this->install->isInstalled());
    }

    public function test_locally_it_wipes_the_database_and_removes_state_and_lock(): void
    {
        $this->answerWizard();
        foreach (['run-migrations', 'seed-defaults', 'create-admin', 'write-lock'] as $step) {
            $this->postJson(route('setup.run', $step))->assertJsonPath('status', 'ok');
        }
        $this->assertTrue(Schema::hasTable('users'));

        $this->app->detectEnvironment(fn () => 'local');

        $this->artisan('chat:install:reset', ['--force' => true])
            ->expectsOutputToContain('Wiped database')
            ->assertExitCode(0);

        $this->assertFalse(Schema::hasTable('users'));
        $this->assertFalse(Schema::hasTable('settings'));
        $this->assertFileDoesNotExist($this->install->statePath());
        $this->assertFileDoesNotExist($this->install->lockPath());
        $this->assertFalse($this->install->isInstalled());
    }

    public function test_it_asks_for_confirmation_without_force(): void
    {
        $this->app->detectEnvironment(fn () => 'local');
        $this->install->writeLock();

        $this->artisan('chat:install:reset')
            ->expectsConfirmation('This wipes every table in the database [:memory:] and removes the install lock. Continue?', 'no')
            ->assertExitCode(1);

        $this->assertTrue($this->install->isInstalled());
    }
}
