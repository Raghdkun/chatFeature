<?php

namespace Tests\Feature\Install;

use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Support\Facades\Artisan;
use Tests\Support\PizzasysMock;

/**
 * `chat:install --mode=pizzasys`: the non-interactive provisioning path (Docker, e2e) verifies the portal administrator
 * live, exactly like the wizard does.
 */
class PizzasysInstallCommandTest extends InstallTestCase
{
    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->portal = PizzasysMock::make()
            ->user('admin@test.local', 'portal-admin-password-1', 'admin', 'Portal Admin')
            ->user('agent@test.local', 'pw', 'agent', 'Plain Agent')
            ->fake();
    }

    /**
     * @param  array<string, mixed>  $auth
     */
    private function cliAnswers(array $auth = []): void
    {
        config([
            'install.cli' => [
                'app_name' => 'CI Chat',
                'app_url' => 'http://localhost:8000',
                'locale' => 'en',
                'timezone' => 'UTC',
                'idle_timeout_minutes' => 45,
                'auth' => [
                    'base_url' => PizzasysMock::BASE_URL,
                    'service_name' => PizzasysMock::SERVICE_NAME,
                    'service_token' => PizzasysMock::SERVICE_TOKEN,
                    'admin_email' => 'admin@test.local',
                    'admin_password' => 'portal-admin-password-1',
                    ...$auth,
                ],
            ],
        ]);
    }

    public function test_it_installs_a_portal_backed_app_from_the_environment(): void
    {
        $this->cliAnswers(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'nats-cli-token', 'super_roles' => 'super-admin, root', 'agent_permission' => 'support.agent']);

        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('write-lock')
            ->expectsOutputToContain('Installed. Sign in at http://localhost:8000/login')
            ->assertExitCode(0);

        $this->assertTrue($this->install->isInstalled());
        $this->assertSame('pizzasys', settings('auth.mode'));
        $this->assertSame(['super-admin', 'root'], settings('auth.pizzasys.super_roles'));
        $this->assertSame('support.agent', settings('auth.pizzasys.agent_permission'));
        $this->assertTrue(settings('auth.pizzasys.nats.enabled'));

        $environment = AuthEnvironment::query()->sole();
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $environment->service_token);
        $this->assertSame('nats-cli-token', $environment->nats_token);

        $admin = User::query()->sole();
        $this->assertSame('admin@test.local', $admin->email);
        $this->assertTrue($admin->is_admin);
        $this->assertNull($admin->password);
        $this->assertSame(1, UserExternalIdentity::query()->count());

        $state = (string) file_get_contents($this->install->statePath());
        foreach ([PizzasysMock::SERVICE_TOKEN, 'nats-cli-token', 'portal-admin-password-1'] as $secret) {
            $this->assertStringNotContainsString($secret, $state);
        }
        $this->assertSame(1, $this->portal->calls('logout'), 'the verification token was closed');
    }

    public function test_the_output_never_shows_a_secret(): void
    {
        $this->cliAnswers();

        Artisan::call('chat:install', ['--mode' => 'pizzasys']);
        $output = Artisan::output();

        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $output);
        $this->assertStringNotContainsString('portal-admin-password-1', $output);
    }

    public function test_a_wrong_service_token_or_admin_stops_before_anything_is_written(): void
    {
        $this->cliAnswers();
        $this->portal->rejectServiceCredential('Invalid service token.');

        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('Portal administrator check failed (unavailable)')
            ->assertExitCode(1);

        $this->portal->acceptServiceCredential();
        $this->cliAnswers(['admin_email' => 'agent@test.local', 'admin_password' => 'pw']);
        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('(not_admin)')
            ->assertExitCode(1);

        $this->cliAnswers(['admin_password' => 'wrong']);
        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('(invalid)')
            ->assertExitCode(1);

        $this->assertFalse($this->install->isInstalled());
        $this->assertSame([], $this->install->read()['run']);
    }

    public function test_incomplete_or_invalid_answers_are_listed(): void
    {
        $this->cliAnswers(['base_url' => 'http://auth.example.com', 'service_name' => 'bad name', 'service_token' => null, 'admin_email' => 'nope']);

        $this->artisan('chat:install', ['--mode' => 'pizzasys'])
            ->expectsOutputToContain('INSTALL_AUTH_')
            ->assertExitCode(1);

        $this->assertFalse($this->install->isInstalled());
        $this->portal->assertNoCalls();
    }
}
