<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Drivers\FortifyDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\SessionContext;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Tests\TestCase;

class FortifyDriverTest extends TestCase
{
    use RefreshDatabase;

    private FortifyDriver $driver;

    protected function setUp(): void
    {
        parent::setUp();

        $this->driver = app(FortifyDriver::class);
    }

    private function loginRequest(string $email, string $password): Request
    {
        return Request::create('/login', 'POST', ['email' => $email, 'password' => $password]);
    }

    public function test_it_identifies_itself_and_reports_its_capabilities(): void
    {
        $this->assertSame('fortify', $this->driver->key());

        $capabilities = $this->driver->capabilities();
        $this->assertFalse($capabilities->canRegister, 'registration is off by default');
        $this->assertTrue($capabilities->canResetPassword);
        $this->assertTrue($capabilities->canManage2fa);
        $this->assertTrue($capabilities->profileEditable);
        $this->assertNull($capabilities->portalUrl);

        settings()->set('auth.allow_registration', true);
        $this->assertTrue($this->driver->capabilities()->canRegister);
    }

    public function test_the_container_resolves_the_driver_for_the_configured_mode(): void
    {
        $this->assertInstanceOf(FortifyDriver::class, app(AuthDriver::class));
    }

    public function test_valid_credentials_of_an_agent_or_admin_are_ok_and_do_not_start_a_session(): void
    {
        $agent = User::factory()->agent()->create(['email' => 'agent@example.test']);
        $admin = User::factory()->admin()->create(['email' => 'admin@example.test']);

        $result = $this->driver->attempt($this->loginRequest('agent@example.test', 'password'));
        $this->assertSame(AuthOutcome::Ok, $result->outcome);
        $this->assertTrue($result->isOk());
        $this->assertTrue($agent->is($result->user));

        $this->assertTrue($admin->is($this->driver->attempt($this->loginRequest('admin@example.test', 'password'))->user));
        $this->assertGuest();
    }

    public function test_wrong_password_and_unknown_email_are_both_just_invalid(): void
    {
        User::factory()->create(['email' => 'agent@example.test']);

        $wrong = $this->driver->attempt($this->loginRequest('agent@example.test', 'nope'));
        $unknown = $this->driver->attempt($this->loginRequest('ghost@example.test', 'password'));

        $this->assertSame(AuthOutcome::Invalid, $wrong->outcome);
        $this->assertSame(AuthOutcome::Invalid, $unknown->outcome);
        $this->assertNull($wrong->user);
        $this->assertNull($wrong->message);
        $this->assertNull($unknown->message);
    }

    public function test_malformed_input_is_invalid_not_an_exception(): void
    {
        User::factory()->create(['email' => 'agent@example.test']);

        $this->assertSame(AuthOutcome::Invalid, $this->driver->attempt(Request::create('/login', 'POST', ['email' => ['x'], 'password' => 'password']))->outcome);
        $this->assertSame(AuthOutcome::Invalid, $this->driver->attempt(Request::create('/login', 'POST', ['email' => 'agent@example.test', 'password' => ['x']]))->outcome);
        $this->assertSame(AuthOutcome::Invalid, $this->driver->attempt(Request::create('/login', 'POST'))->outcome);
    }

    public function test_a_deactivated_account_cannot_sign_in(): void
    {
        User::factory()->inactive()->create(['email' => 'gone@example.test']);

        $result = $this->driver->attempt($this->loginRequest('gone@example.test', 'password'));

        $this->assertSame(AuthOutcome::Invalid, $result->outcome);
        $this->assertStringContainsString('deactivated', (string) $result->message);
    }

    public function test_a_user_who_is_neither_admin_nor_agent_gets_no_chat_access(): void
    {
        $user = User::factory()->withoutChatAccess()->create(['email' => 'nobody@example.test']);

        $result = $this->driver->attempt($this->loginRequest('nobody@example.test', 'password'));

        $this->assertSame(AuthOutcome::NoChatAccess, $result->outcome);
        $this->assertFalse($result->isOk());
        $this->assertTrue($user->is($result->user));
        $this->assertStringContainsString('no access', (string) $result->message);
    }

    public function test_wrong_credentials_of_a_user_without_access_do_not_reveal_that_status(): void
    {
        User::factory()->withoutChatAccess()->create(['email' => 'nobody@example.test']);

        $result = $this->driver->attempt($this->loginRequest('nobody@example.test', 'wrong'));

        $this->assertSame(AuthOutcome::Invalid, $result->outcome);
    }

    public function test_api_login_returns_our_own_sanctum_token(): void
    {
        $user = User::factory()->create(['email' => 'agent@example.test']);

        $result = $this->driver->attemptForApi(['email' => 'agent@example.test', 'password' => 'password'], 'iPhone 17');

        $this->assertSame(AuthOutcome::Ok, $result->outcome);
        $this->assertTrue($user->is($result->user));
        $this->assertNotEmpty($result->token);
        $this->assertStringContainsString('|', (string) $result->token);
        $this->assertDatabaseHas('personal_access_tokens', ['tokenable_id' => $user->id, 'name' => 'iPhone 17']);
        $this->assertDatabaseMissing('personal_access_tokens', ['token' => $result->token]);

        $this->getJson('/api/v1/probe-not-a-route', ['Authorization' => 'Bearer '.$result->token])->assertNotFound();
    }

    public function test_api_login_failures_never_issue_a_token(): void
    {
        User::factory()->create(['email' => 'agent@example.test']);
        User::factory()->withoutChatAccess()->create(['email' => 'nobody@example.test']);
        User::factory()->inactive()->create(['email' => 'gone@example.test']);

        foreach ([
            [['email' => 'agent@example.test', 'password' => 'nope'], AuthOutcome::Invalid],
            [['email' => 'nobody@example.test', 'password' => 'password'], AuthOutcome::NoChatAccess],
            [['email' => 'gone@example.test', 'password' => 'password'], AuthOutcome::Invalid],
            [['email' => 'agent@example.test'], AuthOutcome::Invalid],
        ] as [$credentials, $outcome]) {
            $result = $this->driver->attemptForApi($credentials, 'device');
            $this->assertSame($outcome, $result->outcome);
            $this->assertNull($result->token);
            $this->assertFalse($result->isOk());
        }

        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_session_validation_revokes_only_deactivated_accounts(): void
    {
        $user = User::factory()->create();
        $context = new SessionContext('abc', '127.0.0.1', 'phpunit');

        $this->assertSame(SessionVerdict::Fresh, $this->driver->validateSession($user, $context));

        $user->forceFill(['is_active' => false]);
        $this->assertSame(SessionVerdict::Revoked, $this->driver->validateSession($user, $context));
    }

    public function test_logout_ends_the_session(): void
    {
        $user = User::factory()->create();
        $this->actingAs($user);
        $request = Request::create('/logout', 'POST');
        $request->setLaravelSession($this->app['session.store']);

        $this->driver->logout($request);

        $this->assertGuest();
        $this->assertNull(Auth::user());
    }

    public function test_it_is_always_healthy(): void
    {
        $this->assertTrue($this->driver->health()->isOk());
        $this->assertSame('ok', $this->driver->health()->status);
    }
}
