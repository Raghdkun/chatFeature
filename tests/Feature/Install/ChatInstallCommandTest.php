<?php

namespace Tests\Feature\Install;

use App\Models\User;
use Illuminate\Support\Facades\Hash;

class ChatInstallCommandTest extends InstallTestCase
{
    /**
     * @param  array<string, mixed>  $overrides
     */
    private function cliAnswers(array $overrides = []): void
    {
        config(['install.cli' => array_merge([
            'admin_name' => 'CI Admin',
            'admin_email' => 'ci@example.test',
            'admin_password' => 'a-long-test-password',
            'app_name' => 'CI Chat',
            'app_url' => 'http://localhost:8000',
            'locale' => 'en',
            'timezone' => 'UTC',
            'idle_timeout_minutes' => 45,
        ], $overrides)]);
    }

    public function test_it_installs_non_interactively_from_the_environment(): void
    {
        $this->cliAnswers();

        $this->artisan('chat:install', ['--mode' => 'local'])
            ->expectsOutputToContain('write-lock')
            ->expectsOutputToContain('Installed. Sign in at http://localhost:8000/login')
            ->assertExitCode(0);

        $this->assertTrue($this->install->isInstalled());

        $user = User::query()->where('email', 'ci@example.test')->firstOrFail();
        $this->assertTrue($user->is_admin);
        $this->assertSame('CI Admin', $user->name);
        $this->assertTrue(Hash::check('a-long-test-password', (string) $user->password));
        $this->assertSame('CI Chat', settings('app.name'));
        $this->assertSame(45, settings('chat.default_idle_timeout_minutes'));
        $this->assertStringNotContainsString('a-long-test-password', (string) file_get_contents($this->install->statePath()));
    }

    public function test_running_it_again_is_a_no_op(): void
    {
        $this->cliAnswers();
        $this->artisan('chat:install')->assertExitCode(0);

        $this->artisan('chat:install', ['--mode' => 'local'])
            ->expectsOutputToContain('Already installed')
            ->assertExitCode(0);

        $this->assertSame(1, User::query()->count());
    }

    public function test_the_fortify_alias_is_accepted(): void
    {
        $this->cliAnswers();

        $this->artisan('chat:install', ['--mode' => 'fortify'])->assertExitCode(0);
    }

    public function test_pizzasys_mode_is_not_available_yet(): void
    {
        $this->cliAnswers();

        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('available in P2')
            ->assertExitCode(1);

        $this->assertFalse($this->install->isInstalled());
        $this->assertNull($this->install->mode());
    }

    public function test_an_unknown_mode_is_rejected(): void
    {
        $this->artisan('chat:install', ['--mode' => 'sso'])->assertExitCode(1);
    }

    public function test_missing_or_weak_admin_answers_stop_before_anything_runs(): void
    {
        $this->cliAnswers(['admin_email' => null, 'admin_password' => null]);

        $this->artisan('chat:install')
            ->expectsOutputToContain('INSTALL_ADMIN_EMAIL')
            ->assertExitCode(1);

        $this->cliAnswers(['admin_password' => 'x']);
        $this->artisan('chat:install')->assertExitCode(1);

        $this->cliAnswers(['locale' => 'xx']);
        $this->artisan('chat:install')->assertExitCode(1);

        $this->assertFalse($this->install->isInstalled());
        $this->assertSame([], $this->install->read()['run']);
    }

    public function test_it_reports_a_failing_step_and_can_be_rerun_to_resume(): void
    {
        $this->cliAnswers();
        config(['database.connections.broken' => ['driver' => 'sqlite', 'database' => '/nonexistent/dir/nope.sqlite'], 'database.default' => 'broken']);

        $this->artisan('chat:install')
            ->expectsOutputToContain('check-environment')
            ->assertExitCode(1);
        $this->assertFalse($this->install->isInstalled());

        config(['database.default' => 'sqlite']);

        $this->artisan('chat:install')->assertExitCode(0);
        $this->assertTrue($this->install->isInstalled());
    }
}
