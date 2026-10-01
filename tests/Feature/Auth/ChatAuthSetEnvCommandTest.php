<?php

namespace Tests\Feature\Auth;

use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * `chat:auth:set-env`: the break-glass edit of an environment. Secrets only from a file or a prompt, same
 * "re-enter the token for a new destination" rule as the dashboard, no network.
 */
class ChatAuthSetEnvCommandTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    /** @var list<string> */
    private array $files = [];

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'stored-nats-token']);
    }

    protected function tearDown(): void
    {
        foreach ($this->files as $file) {
            @unlink($file);
        }

        parent::tearDown();
    }

    private function tokenFile(string $token, int $mode = 0600): string
    {
        $path = storage_path('framework/testing/token-'.bin2hex(random_bytes(4)));
        @mkdir(dirname($path), 0775, true);
        file_put_contents($path, $token."\n");
        chmod($path, $mode);

        return $this->files[] = $path;
    }

    private function stored(string $key = 'production'): AuthEnvironment
    {
        return AuthEnvironment::query()->where('key', $key)->sole();
    }

    public function test_it_edits_the_environment_from_a_token_file_without_touching_the_network(): void
    {
        Http::preventStrayRequests();
        Cache::put('auth.nats.restart', 4);
        $file = $this->tokenFile('typed-service-token');

        Artisan::call('chat:auth:set-env', [
            'env' => 'production',
            '--base-url' => 'https://auth-new.example.test',
            '--service-name' => 'chat-two',
            '--token-file' => $file,
            '--clear-nats' => true,
        ]);
        $output = Artisan::output();

        $environment = $this->stored();
        $this->assertSame('https://auth-new.example.test', $environment->base_url);
        $this->assertSame('chat-two', $environment->service_name);
        $this->assertSame('typed-service-token', $environment->service_token);
        $this->assertNull($environment->nats_url);
        $this->assertFalse($environment->hasNatsToken());
        $this->assertCount(0, Http::recorded(), 'no network call');
        $this->assertSame(5, Cache::get('auth.nats.restart'), 'the NATS consumer is told to reconnect');
        $this->assertStringNotContainsString('typed-service-token', $output);

        $row = AuditLog::query()->where('action', 'auth.environment_updated')->sole();
        $this->assertNull($row->actor_id);
        $this->assertSame('cli', $row->changes['via']);
        $this->assertTrue($row->changes['address_changed']);
        $this->assertStringNotContainsString('typed-service-token', (string) json_encode($row->changes));
    }

    public function test_a_secret_can_be_typed_at_a_hidden_prompt(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--base-url' => 'https://auth-new.example.test', '--clear-nats' => true])
            ->expectsQuestion('Re-enter the service token to change the portal address.', 'prompted-token')
            ->assertSuccessful();

        $this->assertSame('prompted-token', $this->stored()->service_token);
    }

    public function test_the_stored_token_is_never_reused_for_a_new_address(): void
    {
        // not interactive and no file: it refuses instead of keeping the old token
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--base-url' => 'https://auth-new.example.test', '--no-interaction' => true])
            ->assertFailed();

        $this->assertSame(PizzasysMock::BASE_URL, $this->stored()->base_url);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token);
    }

    public function test_a_new_nats_address_needs_the_nats_token_again(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--nats-url' => 'nats://other.example.test:4222', '--no-interaction' => true])
            ->assertFailed();
        $this->assertSame('nats://nats.example.test:4222', $this->stored()->nats_url);

        $this->artisan('chat:auth:set-env', ['env' => 'production', '--nats-url' => 'nats://other.example.test:4222', '--nats-token-file' => $this->tokenFile('new-nats-token')])
            ->assertSuccessful();

        $this->assertSame('nats://other.example.test:4222', $this->stored()->nats_url);
        $this->assertSame('new-nats-token', $this->stored()->nats_token);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token, 'untouched');
    }

    public function test_a_change_that_keeps_every_destination_needs_no_token(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--api-prefix' => '/api/v1'])->assertSuccessful();

        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $this->stored()->service_token);
    }

    public function test_it_creates_a_missing_environment_when_given_everything(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'testing'])->assertFailed();

        $this->artisan('chat:auth:set-env', [
            'env' => 'testing',
            '--base-url' => 'https://auth-testing.example.test',
            '--service-name' => 'chat-testing',
            '--token-file' => $this->tokenFile('testing-token'),
        ])->assertSuccessful();

        $this->assertSame('testing-token', $this->stored('testing')->service_token);
        $this->assertSame('production', settings('auth.pizzasys.active_env'), 'never activates anything');
        $this->assertDatabaseHas('audit_logs', ['action' => 'auth.environment_created']);
    }

    public function test_bad_input_is_refused(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'staging'])->assertFailed();
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--base-url' => 'ftp://nope.example.test'])->assertFailed();
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--service-name' => 'has spaces'])->assertFailed();
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--token-file' => '/nonexistent/token'])->assertFailed();
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--verify-tls' => 'perhaps'])->assertFailed();
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--base-url' => 'https://elsewhere.example.test', '--token-file' => $this->tokenFile('   ')])->assertFailed();

        $this->assertSame(PizzasysMock::BASE_URL, $this->stored()->base_url);
    }

    public function test_it_does_nothing_outside_mode_two_or_before_install(): void
    {
        settings()->set('auth.mode', 'fortify');
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--api-prefix' => '/x'])->assertFailed();

        settings()->set('auth.mode', 'pizzasys');
        InstallStateFake::make(installed: false);
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--api-prefix' => '/x'])->assertFailed();
    }

    public function test_a_world_readable_token_file_is_warned_about(): void
    {
        $this->artisan('chat:auth:set-env', ['env' => 'production', '--token-file' => $this->tokenFile('typed-token', 0644)])
            ->expectsOutputToContain('can be read by other users')
            ->assertSuccessful();
    }
}
