<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\AuditLog;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Switching production <-> testing from the dashboard: proven by an admin login on the TARGET portal, then every session
 * of the other environment (the actor's included) is revoked.
 */
class EnvironmentActivationTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private const TESTING_URL = 'https://auth-testing.example.test';

    private PizzasysMock $production;

    private PizzasysMock $testing;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->usePortalMode();
        $this->useTestingEnvironment(self::TESTING_URL);

        $this->production = PizzasysMock::make()
            ->user('admin@test.local', 'prod-pass', 'admin', 'Prod Admin')
            ->user('agent@test.local', 'prod-pass', 'agent', 'Prod Agent')
            ->fake();
        $this->testing = PizzasysMock::make(self::TESTING_URL)
            ->user('admin@test.local', 'test-pass', 'admin', 'Test Admin')
            ->user('agent@test.local', 'test-pass', 'agent', 'Test Agent')
            ->user('norole@test.local', 'test-pass', 'norole', 'Nobody')
            ->fake();
    }

    private function signInOnProduction(string $email = 'admin@test.local'): void
    {
        $this->post(route('login.store'), ['email' => $email, 'password' => 'prod-pass'])->assertRedirect(route('dashboard', absolute: false));
    }

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function activate(array $overrides = [])
    {
        return $this->postJson(route('settings.auth.active-environment'), [
            'env' => 'testing',
            'email' => 'admin@test.local',
            'password' => 'test-pass',
            'confirm' => true,
            ...$overrides,
        ]);
    }

    public function test_an_admin_who_can_sign_in_on_the_target_switches_the_environment(): void
    {
        $this->signInOnProduction();
        $actorSession = ExternalSession::query()->sole();
        Cache::put('auth.nats.restart', 4);

        $this->activate()->assertOk()->assertExactJson(['ok' => true, 'redirect' => '/login']);

        $this->assertSame('testing', settings('auth.pizzasys.active_env'));
        $this->assertNotNull($actorSession->fresh()->revoked_at, 'the actor\'s own session ends too');
        $this->assertSame('environment_switched', $actorSession->fresh()->revoked_reason);
        $this->assertGuest();
        $this->assertSame(5, Cache::get('auth.nats.restart'), 'the NATS consumer is told to reconnect');
    }

    public function test_the_check_login_is_closed_again_and_leaves_no_session(): void
    {
        $this->signInOnProduction();

        $this->activate()->assertOk();

        $this->assertSame(1, $this->testing->calls('login'));
        $this->assertSame(1, $this->testing->calls('token-verify'));
        $this->assertSame(1, $this->testing->calls('logout'), 'upstream tokens never expire, so the check token is closed');
        $this->assertSame(0, ExternalSession::query()->where('auth_environment_id', AuthEnvironment::query()->where('key', 'testing')->value('id'))->count());
    }

    public function test_every_session_of_the_other_environment_is_revoked_not_just_the_actors(): void
    {
        $this->signInOnProduction('agent@test.local');
        $this->post(route('logout'));
        $this->signInOnProduction();
        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
        // a mobile session of another person
        $other = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'prod-pass'], 'phone');
        $this->assertTrue($other->isOk());
        $this->assertSame(2, ExternalSession::query()->whereNull('revoked_at')->count());

        $this->activate()->assertOk();

        $this->assertSame(0, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_an_audit_row_records_who_switched_what_without_any_secret(): void
    {
        $this->signInOnProduction();
        $actor = User::query()->where('email', 'admin@test.local')->sole();

        $this->activate()->assertOk();

        $row = AuditLog::query()->where('action', 'auth.environment_activated')->sole();
        $this->assertSame($actor->id, $row->actor_id);
        $this->assertSame(['from' => 'production', 'to' => 'testing', 'via' => 'dashboard', 'revoked_sessions' => 1], $row->changes);

        $dump = (string) json_encode(AuditLog::query()->get()->toArray());
        $this->assertStringNotContainsString('test-pass', $dump);
        $this->assertStringNotContainsString('prod-pass', $dump);
        $this->assertStringNotContainsString(PizzasysMock::SERVICE_TOKEN, $dump);
    }

    public function test_people_sign_in_on_the_new_environment_and_keep_their_local_account(): void
    {
        $this->signInOnProduction();
        $before = User::query()->where('email', 'admin@test.local')->sole();
        $this->activate()->assertOk();

        $this->post(route('login.store'), ['email' => 'admin@test.local', 'password' => 'test-pass'])->assertRedirect(route('dashboard', absolute: false));

        $this->assertSame(1, User::query()->where('email', 'admin@test.local')->count());
        $this->assertTrue($before->is(User::query()->where('email', 'admin@test.local')->sole()), 'linked by email');
        $this->assertSame(2, $before->externalIdentities()->count());
        $this->assertSame('Test Admin', $before->fresh()->name);
        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertSame(self::TESTING_URL, app(AuthDriver::class)->capabilities()->portalUrl);
    }

    public function test_wrong_credentials_on_the_target_are_refused_and_nothing_changes(): void
    {
        $this->signInOnProduction();

        $this->activate(['password' => 'nope'])->assertStatus(422)->assertJsonPath('ok', false)->assertJsonPath('code', 'invalid');

        $this->assertSame('production', settings('auth.pizzasys.active_env'));
        $this->assertAuthenticated();
        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
    }

    public function test_an_account_that_is_not_an_admin_on_the_target_cannot_be_used(): void
    {
        $this->signInOnProduction();

        $this->activate(['email' => 'agent@test.local'])->assertStatus(422)->assertJsonPath('code', 'not_admin');
        $this->activate(['email' => 'norole@test.local'])->assertStatus(422)->assertJsonPath('code', 'not_admin');

        $this->assertSame('production', settings('auth.pizzasys.active_env'));
        $this->assertSame(2, $this->testing->calls('logout'), 'their tokens were closed as well');
    }

    public function test_an_unreachable_target_cannot_be_activated(): void
    {
        $this->signInOnProduction();
        $this->testing->outage('connection');

        $this->activate()->assertStatus(422)->assertJsonPath('code', 'unavailable');

        $this->assertSame('production', settings('auth.pizzasys.active_env'));
    }

    public function test_a_target_that_rejects_our_service_credential_cannot_be_activated(): void
    {
        $this->signInOnProduction();
        $this->testing->rejectServiceCredential('Service is inactive.');

        $this->activate()->assertStatus(422)->assertJsonPath('code', 'service_rejected');

        $this->assertSame('production', settings('auth.pizzasys.active_env'));
    }

    public function test_an_unconfigured_or_already_active_environment_is_refused(): void
    {
        $this->signInOnProduction();
        AuthEnvironment::query()->where('key', 'testing')->delete();

        $this->activate()->assertStatus(422)->assertJsonPath('code', 'not_configured');
        $this->activate(['env' => 'production'])->assertStatus(422)->assertJsonPath('code', 'already_active');
    }

    public function test_the_request_must_be_confirmed_and_complete(): void
    {
        $this->signInOnProduction();

        $this->activate(['confirm' => false])->assertStatus(422)->assertJsonPath('ok', false)->assertJsonStructure(['ok', 'message', 'errors' => ['confirm']]);
        $this->activate(['env' => 'staging'])->assertStatus(422)->assertJsonValidationErrors('env');
        $this->activate(['email' => 'not-an-email'])->assertStatus(422)->assertJsonValidationErrors('email');
        $this->activate(['password' => ''])->assertStatus(422)->assertJsonValidationErrors('password');

        $this->assertSame(0, $this->testing->calls('login'));
        $this->assertSame('production', settings('auth.pizzasys.active_env'));
    }

    public function test_an_agent_cannot_activate_an_environment(): void
    {
        $this->signInOnProduction('agent@test.local');

        $this->activate()->assertForbidden();

        $this->assertSame(0, $this->testing->calls('login'));
        $this->assertSame('production', settings('auth.pizzasys.active_env'));
    }

    public function test_guests_cannot_activate_an_environment(): void
    {
        $this->activate()->assertUnauthorized();

        $this->assertSame(0, $this->testing->calls('login'));
    }

    public function test_the_endpoint_does_not_exist_in_mode_one(): void
    {
        $this->signInOnProduction();
        settings()->set('auth.mode', 'fortify');
        $admin = User::factory()->admin()->create(['auth_source' => 'local']);
        $this->post(route('logout'));

        $this->actingAs($admin)->postJson(route('settings.auth.active-environment'), ['env' => 'testing', 'email' => 'a@b.test', 'password' => 'x', 'confirm' => true])->assertNotFound();
    }

    public function test_the_password_is_throttled(): void
    {
        $this->signInOnProduction();

        for ($i = 0; $i < 5; $i++) {
            $this->activate(['password' => 'nope'])->assertStatus(422);
        }

        $this->activate(['password' => 'nope'])->assertStatus(429);
    }
}
