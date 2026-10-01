<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Monolog\Handler\TestHandler;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Secrets (service token, NATS token, upstream user tokens, passwords) exist only encrypted in the database and in
 * memory: never in logs, audit rows, settings, JSON/Inertia responses or the cache.
 */
class PortalSecretsTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private const NATS_TOKEN = 'nats-secret-token-value';

    private const PASSWORD = 'very-secret-portal-password';

    private PizzasysMock $portal;

    private TestHandler $logs;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config([
            'inertia.testing.ensure_pages_exist' => false,
            'logging.default' => 'capture',
            'logging.channels.capture' => ['driver' => 'monolog', 'handler' => TestHandler::class, 'level' => 'debug'],
        ]);
        $this->app->forgetInstance('log');
        Log::clearResolvedInstance('log');
        $handler = Log::channel('capture')->getLogger()->getHandlers()[0];
        $this->assertInstanceOf(TestHandler::class, $handler);
        $this->logs = $handler;

        $this->usePortalMode(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => self::NATS_TOKEN]);
        $this->portal = PizzasysMock::make()
            ->user('admin@test.local', self::PASSWORD, 'admin', 'Prod Admin')
            ->user('agent@test.local', self::PASSWORD, 'agent', 'Prod Agent')
            ->fake();
    }

    /**
     * @return list<string>
     */
    private function secrets(): array
    {
        return [
            PizzasysMock::SERVICE_TOKEN,
            self::NATS_TOKEN,
            self::PASSWORD,
            $this->portal->tokenFor('admin@test.local'),
            $this->portal->tokenFor('agent@test.local'),
            explode('|', $this->portal->tokenFor('admin@test.local'))[1],
        ];
    }

    private function assertNothingLeaked(string $haystack, string $where): void
    {
        foreach ($this->secrets() as $secret) {
            $this->assertStringNotContainsString($secret, $haystack, "a secret leaked into {$where}");
        }
    }

    public function test_no_log_line_ever_contains_a_secret_across_every_flow(): void
    {
        // sign in, revalidate, fail, break the portal until the circuit opens, reject the credential, sign out
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertRedirect();
        $this->post(route('logout'));
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => 'wrong'])->assertSessionHasErrors();

        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertRedirect();
        $this->portal->revoke('admin@test.local');
        $this->travel(2)->minutes();
        $this->get(route('dashboard'));

        $this->portal->reissueToken('agent@test.local');
        $this->portal->outage('connection');
        for ($i = 0; $i < 6; $i++) {
            app(AuthDriver::class)->attempt(Request::create('/login', 'POST', ['email' => 'agent@test.local', 'password' => self::PASSWORD]));
        }
        $this->portal->recover();
        $this->travel(2)->minutes();

        $this->portal->rejectServiceCredential('Invalid service token.');
        app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => self::PASSWORD], 'phone');

        $records = $this->logs->getRecords();
        $this->assertNotEmpty($records, 'the capture works: the circuit breaker logs when it opens');
        $dump = (string) json_encode(array_map(fn ($record): array => ['message' => $record->message, 'context' => $record->context, 'extra' => $record->extra], $records));

        $this->assertStringContainsString('circuit opened', $dump);
        $this->assertNothingLeaked($dump, 'the logs');
    }

    public function test_the_database_keeps_secrets_only_encrypted(): void
    {
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertRedirect();

        $environment = AuthEnvironment::query()->sole();
        $this->assertNotSame(PizzasysMock::SERVICE_TOKEN, $environment->service_token_encrypted);
        $this->assertNotSame(self::NATS_TOKEN, $environment->nats_token_encrypted);
        $this->assertSame(PizzasysMock::SERVICE_TOKEN, $environment->service_token);
        $this->assertSame(self::NATS_TOKEN, $environment->nats_token);

        $session = ExternalSession::query()->sole();
        $this->assertNotSame($this->portal->tokenFor('admin@test.local'), $session->token_encrypted);
        $this->assertSame($this->portal->tokenFor('admin@test.local'), $session->token);

        // settings and audit rows are plain tables: nothing secret may be in them
        $this->assertNothingLeaked((string) json_encode(DB::table('settings')->get()), 'settings');
        $this->assertNothingLeaked((string) json_encode(AuditLog::query()->get()->toArray()), 'audit_logs');
    }

    public function test_models_never_serialise_their_secrets(): void
    {
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD]);

        $environment = AuthEnvironment::query()->sole();
        $session = ExternalSession::query()->sole();

        foreach ([$environment->toArray(), $environment->toJson(), $session->toArray(), $session->toJson()] as $serialised) {
            $this->assertNothingLeaked(is_string($serialised) ? $serialised : (string) json_encode($serialised), 'a serialised model');
        }
        $this->assertArrayNotHasKey('service_token_encrypted', $environment->toArray());
        $this->assertArrayNotHasKey('token_encrypted', $session->toArray());
        $this->assertArrayNotHasKey('service_token', $environment->toArray());
    }

    public function test_pages_and_json_responses_carry_no_secret(): void
    {
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertRedirect();

        foreach ([
            $this->get(route('dashboard')),
            $this->get(route('settings.auth.edit')),
            $this->postJson(route('settings.auth.environments.test', 'production')),
            $this->put(route('settings.auth.environments.update', 'production'), [
                'base_url' => PizzasysMock::BASE_URL, 'service_name' => PizzasysMock::SERVICE_NAME, 'nats_url' => 'nats://nats.example.test:4222',
                'service_token' => 'replacement-service-token', 'nats_token' => 'replacement-nats-token',
            ]),
            $this->get(route('settings.auth.edit')),
        ] as $response) {
            $this->assertNothingLeaked($response->getContent(), 'a response');
            $this->assertStringNotContainsString('replacement-service-token', $response->getContent());
            $this->assertStringNotContainsString('replacement-nats-token', $response->getContent());
        }

        $audit = (string) json_encode(AuditLog::query()->get()->toArray());
        $this->assertStringNotContainsString('replacement-service-token', $audit);
        $this->assertStringNotContainsString('replacement-nats-token', $audit);
    }

    public function test_the_session_only_carries_the_portal_session_id(): void
    {
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertRedirect();

        $this->assertNothingLeaked((string) json_encode(session()->all()), 'the browser session');
    }

    public function test_the_setup_wizard_never_echoes_the_tokens_it_stores(): void
    {
        // covered in depth by PizzasysSetupWizardTest; here: the failure path of the connection test names no secret either
        $this->portal->rejectServiceCredential('Invalid service token.');
        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => self::PASSWORD])->assertSessionHasErrors('email');

        $this->assertNothingLeaked((string) json_encode(session('errors')?->getBag('default')?->toArray()), 'login errors');
    }
}
