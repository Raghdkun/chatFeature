<?php

namespace Tests\Feature\Auth;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Drivers\PizzasysDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Pizzasys\PendingPortalLogins;
use App\Auth\Support\SessionContext;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

class PizzasysDriverTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()
            ->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')
            ->user('admin@test.local', 'admin-pass', 'admin', 'Test Admin')
            ->user('chatadmin@test.local', 'chatadmin-pass', 'chatadmin', 'Chat Admin')
            ->user('norole@test.local', 'norole-pass', 'norole', 'No Role')
            ->user('roleagent@test.local', 'roleagent-pass', 'roleagent', 'Role Agent')
            ->fake();
    }

    private function driver(): PizzasysDriver
    {
        return app(PizzasysDriver::class);
    }

    private function loginRequest(string $email, string $password): Request
    {
        return Request::create('/login', 'POST', ['email' => $email, 'password' => $password]);
    }

    public function test_the_manager_resolves_the_pizzasys_driver_in_mode_two(): void
    {
        $this->assertInstanceOf(PizzasysDriver::class, app(AuthDriver::class));
        $this->assertSame('pizzasys', app(AuthModeManager::class)->activeDriver()->key());
    }

    public function test_capabilities_hand_everything_to_the_portal(): void
    {
        $capabilities = $this->driver()->capabilities();

        $this->assertFalse($capabilities->canRegister);
        $this->assertFalse($capabilities->canResetPassword);
        $this->assertFalse($capabilities->canManage2fa);
        $this->assertFalse($capabilities->profileEditable);
        $this->assertNull($capabilities->portalUrl, 'the mock portal lives on a reserved .test name: nothing to show');
    }

    public function test_the_portal_label_is_a_public_host_name_and_nothing_else(): void
    {
        $cases = [
            'https://auth.example.com' => 'https://auth.example.com',
            'https://Auth.Example.COM:8443/internal/api?x=1' => 'https://auth.example.com',
            'http://auth.example.com/portal' => 'https://auth.example.com',
            'https://auth.example.com.' => 'https://auth.example.com',
            'http://10.0.0.5:8200' => null,
            'https://203.0.113.9' => null,
            'https://[2606:4700:4700::1111]' => null,
            'http://pizzasys:8200' => null,
            'http://localhost:8200' => null,
            'http://127.0.0.1:8200' => null,
            'https://portal.internal' => null,
            'https://portal.local' => null,
            'https://portal.localhost' => null,
            'https://portal.example.test' => null,
            'https://2852039166' => null,
            '' => null,
        ];

        foreach ($cases as $baseUrl => $label) {
            AuthEnvironment::query()->update(['base_url' => $baseUrl]);

            $this->assertSame($label, $this->driver()->capabilities()->portalUrl, $baseUrl);
        }
    }

    public function test_an_agent_signs_in_and_a_shadow_user_is_created_without_starting_a_session(): void
    {
        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::Ok, $result->outcome);
        $user = $result->user;
        $this->assertInstanceOf(User::class, $user);
        $this->assertGuest();

        $this->assertSame('agent@test.local', $user->email);
        $this->assertSame('Test Agent', $user->name);
        $this->assertSame('pizzasys', $user->auth_source);
        $this->assertNull($user->password);
        $this->assertNotNull($user->email_verified_at);
        $this->assertTrue($user->is_agent);
        $this->assertFalse($user->is_admin);

        $identity = UserExternalIdentity::query()->where('user_id', $user->id)->sole();
        $this->assertSame($this->portal->idFor('agent@test.local'), $identity->external_id);
        $this->assertSame(['chat.agent'], $identity->permissions);

        // No session yet: the Login listener opens it once the guard logs the user in.
        $this->assertSame(0, ExternalSession::query()->count());
    }

    public function test_the_verdict_is_memoised_per_request(): void
    {
        $request = $this->loginRequest('agent@test.local', 'agent-pass');

        $first = $this->driver()->attempt($request);
        $second = $this->driver()->attempt($request);

        $this->assertSame($first, $second);
        $this->assertSame(1, $this->portal->calls('login'));
        $this->assertSame(1, $this->portal->calls('token-verify'));
    }

    public function test_login_is_immediately_verified_with_the_service_credential(): void
    {
        $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        Http::assertSent(fn ($request): bool => str_ends_with($request->url(), '/auth/token-verify')
            && $request->hasHeader('Authorization', 'Bearer '.PizzasysMock::SERVICE_TOKEN)
            && $request->hasHeader('Accept', 'application/json')
            && $request['service'] === PizzasysMock::SERVICE_NAME);
    }

    public function test_wrong_credentials_are_just_invalid(): void
    {
        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'nope'));

        $this->assertSame(AuthOutcome::Invalid, $result->outcome);
        $this->assertNull($result->user);
        $this->assertNull($result->message);
        $this->assertSame(0, User::query()->count());
        $this->assertSame(0, $this->portal->calls('token-verify'));
    }

    public function test_malformed_input_is_invalid_without_calling_the_portal(): void
    {
        foreach ([
            ['email' => ['x'], 'password' => 'p'],
            ['email' => 'agent@test.local', 'password' => ['x']],
            ['email' => '', 'password' => 'p'],
            [],
        ] as $input) {
            $this->assertSame(AuthOutcome::Invalid, $this->driver()->attempt(Request::create('/login', 'POST', $input))->outcome);
        }

        $this->portal->assertNoCalls();
    }

    public function test_an_unreachable_portal_is_unavailable_with_a_message(): void
    {
        $this->portal->outage('connection');

        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::Unavailable, $result->outcome);
        $this->assertStringContainsString('Auth Portal unreachable', (string) $result->message);
    }

    public function test_server_errors_timeouts_and_unreadable_answers_are_all_unavailable(): void
    {
        foreach (['server_error', 'timeout', 'html', 'tls'] as $kind) {
            $this->portal->outage($kind);
            $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));
            $this->assertSame(AuthOutcome::Unavailable, $result->outcome, $kind);
        }
    }

    public function test_a_rejected_service_credential_fails_closed_for_new_logins_and_closes_the_upstream_token(): void
    {
        $this->portal->rejectServiceCredential('Invalid service token.');

        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::Unavailable, $result->outcome);
        $this->assertStringContainsString('service credentials', (string) $result->message);
        $this->assertSame(0, User::query()->count());
        $this->assertSame(1, $this->portal->calls('logout'), 'the unused token is closed upstream');
        $this->assertSame(0, $this->portal->calls('me'), 'new sign-ins never fall back to /auth/me');
    }

    public function test_a_portal_user_with_no_chat_role_gets_no_chat_access_and_no_local_account(): void
    {
        $result = $this->driver()->attempt($this->loginRequest('norole@test.local', 'norole-pass'));

        $this->assertSame(AuthOutcome::NoChatAccess, $result->outcome);
        $this->assertStringContainsString('no access', (string) $result->message);
        $this->assertSame(0, User::query()->count());
        $this->assertSame(1, $this->portal->calls('logout'));
    }

    public function test_an_existing_account_that_lost_its_chat_role_is_demoted_and_refused(): void
    {
        $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));
        $this->portal->claims('agent@test.local', [], []);

        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::NoChatAccess, $result->outcome);
        $user = User::query()->where('email', 'agent@test.local')->sole();
        $this->assertFalse($user->is_agent);
        $this->assertFalse($user->is_admin);
    }

    public function test_a_super_role_makes_an_admin_who_is_also_an_agent(): void
    {
        $user = $this->driver()->attempt($this->loginRequest('admin@test.local', 'admin-pass'))->user;

        $this->assertInstanceOf(User::class, $user);
        $this->assertTrue($user->is_admin, 'super-admin carries no chat.* permission but is an admin by role name');
        $this->assertTrue($user->is_agent);
    }

    public function test_the_admin_permission_makes_an_admin(): void
    {
        $user = $this->driver()->attempt($this->loginRequest('chatadmin@test.local', 'chatadmin-pass'))->user;

        $this->assertInstanceOf(User::class, $user);
        $this->assertTrue($user->is_admin);
        $this->assertTrue($user->is_agent);
    }

    public function test_the_agent_permission_via_a_role_is_an_agent_but_not_an_admin(): void
    {
        $user = $this->driver()->attempt($this->loginRequest('roleagent@test.local', 'roleagent-pass'))->user;

        $this->assertInstanceOf(User::class, $user);
        $this->assertTrue($user->is_agent);
        $this->assertFalse($user->is_admin);
    }

    public function test_a_deactivated_local_account_cannot_sign_in(): void
    {
        $user = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'))->user;
        $user->forceFill(['is_active' => false])->save();

        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::Invalid, $result->outcome);
        $this->assertStringContainsString('deactivated', (string) $result->message);
    }

    public function test_an_unconfigured_portal_is_unavailable(): void
    {
        AuthEnvironment::query()->delete();

        $result = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'));

        $this->assertSame(AuthOutcome::Unavailable, $result->outcome);
        $this->assertStringContainsString('not configured', (string) $result->message);
    }

    public function test_api_login_issues_our_own_sanctum_token_bound_to_a_portal_session(): void
    {
        $result = $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'iPhone 17');

        $this->assertSame(AuthOutcome::Ok, $result->outcome);
        $this->assertNotEmpty($result->token);
        $this->assertStringNotContainsString($this->portal->tokenFor('agent@test.local'), (string) $result->token, 'the upstream token never leaves the server');

        $token = PersonalAccessToken::findToken((string) $result->token);
        $this->assertNotNull($token);
        $this->assertSame(['staff'], $token->abilities);

        $session = ExternalSession::query()->sole();
        $this->assertSame($token->getKey(), $session->sanctum_token_id);
        $this->assertSame($this->portal->tokenFor('agent@test.local'), $session->token);
        $this->assertDatabaseMissing('external_sessions', ['token_encrypted' => $this->portal->tokenFor('agent@test.local')]);
    }

    public function test_api_login_failures_never_issue_a_token(): void
    {
        $this->portal->claims('norole@test.local', [], []);

        foreach ([
            [['email' => 'agent@test.local', 'password' => 'nope'], AuthOutcome::Invalid],
            [['email' => 'norole@test.local', 'password' => 'norole-pass'], AuthOutcome::NoChatAccess],
            [['email' => 'agent@test.local'], AuthOutcome::Invalid],
        ] as [$credentials, $outcome]) {
            $result = $this->driver()->attemptForApi($credentials, 'device');
            $this->assertSame($outcome, $result->outcome);
            $this->assertNull($result->token);
        }

        $this->portal->outage('connection');
        $this->assertSame(AuthOutcome::Unavailable, $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'device')->outcome);

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertDatabaseCount('external_sessions', 0);
    }

    public function test_a_pending_login_is_handed_over_once_and_only_for_that_user(): void
    {
        $user = $this->driver()->attempt($this->loginRequest('agent@test.local', 'agent-pass'))->user;
        $pending = app(PendingPortalLogins::class);

        $this->assertNull($pending->pull($user->id + 1));
        $this->assertNotNull($pending->pull($user->id));
        $this->assertNull($pending->pull($user->id));
    }

    // ---- session validation -------------------------------------------------------------------------------------

    /**
     * @return array{0: User, 1: ExternalSession, 2: SessionContext}
     */
    private function signedIn(string $email = 'agent@test.local', string $password = 'agent-pass'): array
    {
        $result = $this->driver()->attemptForApi(['email' => $email, 'password' => $password], 'phone');
        $user = $result->user;
        $this->assertInstanceOf(User::class, $user);
        $session = ExternalSession::query()->where('user_id', $user->id)->latest('id')->firstOrFail();

        return [$user, $session, new SessionContext(null, '127.0.0.1', 'phpunit', null, $session->sanctum_token_id)];
    }

    public function test_a_session_with_a_fresh_cached_verify_is_fresh_without_calling_the_portal(): void
    {
        [$user, , $context] = $this->signedIn();
        $verifies = $this->portal->calls('token-verify');

        $this->assertSame(SessionVerdict::Fresh, $this->driver()->validateSession($user, $context));
        $this->assertSame(SessionVerdict::Fresh, $this->driver()->validateSession($user, $context));
        $this->assertSame($verifies, $this->portal->calls('token-verify'));
    }

    public function test_a_session_whose_cache_expired_is_reverified_and_updates_the_identity(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->claims('agent@test.local', [], ['chat.agent', 'extra.permission']);
        $this->travel(2)->minutes();
        $verifies = $this->portal->calls('token-verify');

        $verdict = $this->driver()->validateSession($user, $context);

        $this->assertSame(SessionVerdict::Revalidated, $verdict);
        $this->assertSame($verifies + 1, $this->portal->calls('token-verify'));
        $identity = $session->identity()->first();
        $this->assertSame(['chat.agent', 'extra.permission'], $identity->permissions);
        $this->assertNull($identity->stale_at);
        $this->assertTrue($session->fresh()->last_verified_at->greaterThan($session->last_verified_at));
    }

    public function test_a_token_revoked_upstream_revokes_the_session_and_our_tokens(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->revoke('agent@test.local');
        $this->travel(2)->minutes();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, $context));

        $session->refresh();
        $this->assertNotNull($session->revoked_at);
        $this->assertSame('upstream_inactive', $session->revoked_reason);
        $this->assertNull($session->token, 'the upstream token is wiped from our database');
        $this->assertSame(0, PersonalAccessToken::query()->count());
        $this->assertSame(0, $this->portal->calls('logout'), 'a token the portal already forgot is not logged out again');
    }

    public function test_a_revoked_session_stays_revoked(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $session->forceFill(['revoked_at' => now()])->save();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, $context));
    }

    public function test_an_unbound_request_is_never_trusted(): void
    {
        [$user] = $this->signedIn();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, new SessionContext('abc', '127.0.0.1', 'phpunit')));
        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, new SessionContext(null, null, null, 'nonexistent-id')));
    }

    public function test_a_session_of_another_user_is_not_accepted(): void
    {
        [, , $context] = $this->signedIn('agent@test.local', 'agent-pass');
        $other = User::factory()->agent()->create(['auth_source' => 'pizzasys']);

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($other, $context));
    }

    public function test_a_deactivated_user_or_identity_is_revoked(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $user->forceFill(['is_active' => false])->saveQuietly();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user->refresh(), $context));
        $this->assertSame('deactivated', $session->fresh()->revoked_reason);
    }

    public function test_the_portal_being_down_is_degraded_within_the_grace_window_then_unavailable(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->outage('connection');
        $this->travel(2)->minutes();

        $this->assertSame(SessionVerdict::Degraded, $this->driver()->validateSession($user, $context));
        $this->assertSame(1, $session->fresh()->verify_fail_count);

        $this->travel(27)->minutes();
        $this->assertSame(SessionVerdict::Degraded, $this->driver()->validateSession($user, $context), 'still inside 30 minutes of the last verification');

        $this->travel(3)->minutes();
        $this->assertSame(SessionVerdict::Unavailable, $this->driver()->validateSession($user, $context));
        $this->assertNull($session->fresh()->revoked_at, 'an outage never revokes the session');
    }

    public function test_the_grace_window_follows_the_setting(): void
    {
        settings()->set('auth.pizzasys.grace_minutes', 5);
        [$user, , $context] = $this->signedIn();
        $this->portal->outage('timeout');
        $this->travel(6)->minutes();

        $this->assertSame(SessionVerdict::Unavailable, $this->driver()->validateSession($user, $context));
    }

    public function test_the_session_recovers_when_the_portal_comes_back(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->outage('server_error');
        $this->travel(3)->minutes();
        $this->assertSame(SessionVerdict::Degraded, $this->driver()->validateSession($user, $context));

        $this->portal->recover();
        $this->travel(1)->minute();

        $this->assertSame(SessionVerdict::Revalidated, $this->driver()->validateSession($user, $context));
        $this->assertSame(0, $session->fresh()->verify_fail_count);
    }

    public function test_when_the_service_credential_is_rejected_sessions_fall_back_to_the_user_token(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->rejectServiceCredential('Service token expired.');
        $this->travel(2)->minutes();

        $verdict = $this->driver()->validateSession($user, $context);

        $this->assertSame(SessionVerdict::Revalidated, $verdict);
        $this->assertSame(1, $this->portal->calls('me'));
        $this->assertNull($session->fresh()->revoked_at);

        $health = $this->driver()->health();
        $this->assertSame('degraded', $health->status);
        $this->assertTrue($health->details['service_credential_rejected']);
    }

    public function test_the_me_fallback_still_revokes_a_dead_token_and_maps_roles_from_global_data(): void
    {
        [$user, $session, $context] = $this->signedIn('roleagent@test.local', 'roleagent-pass');
        $this->portal->rejectServiceCredential();
        $this->travel(2)->minutes();

        $this->assertSame(SessionVerdict::Revalidated, $this->driver()->validateSession($user, $context));
        $this->assertTrue($user->refresh()->is_agent, 'a permission granted through a role is read from the role');

        $this->portal->revoke('roleagent@test.local');
        $this->travel(2)->minutes();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, $context));
    }

    public function test_losing_the_chat_role_upstream_revokes_the_session(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->portal->claims('agent@test.local', [], []);
        $this->travel(2)->minutes();

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, $context));
        $this->assertSame('no_chat_access', $session->fresh()->revoked_reason);
        $this->assertFalse($user->refresh()->hasChatAccess());
    }

    public function test_a_session_of_the_inactive_environment_is_revoked(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->useTestingEnvironment();
        settings()->set('auth.pizzasys.active_env', 'testing');

        $this->assertSame(SessionVerdict::Revoked, $this->driver()->validateSession($user, $context));
        $this->assertSame('environment_switched', $session->fresh()->revoked_reason);
    }

    public function test_a_stale_identity_is_reverified_even_when_the_answer_is_cached(): void
    {
        [$user, $session, $context] = $this->signedIn();
        $this->assertSame(SessionVerdict::Fresh, $this->driver()->validateSession($user, $context));
        $session->identity()->first()->forceFill(['stale_at' => now()])->save();
        $verifies = $this->portal->calls('token-verify');

        $this->assertSame(SessionVerdict::Revalidated, $this->driver()->validateSession($user, $context));
        $this->assertSame($verifies + 1, $this->portal->calls('token-verify'));
        $this->assertNull($session->identity()->first()->stale_at);
    }

    // ---- logout + health ----------------------------------------------------------------------------------------

    public function test_logout_revokes_the_session_and_logs_out_only_that_upstream_token(): void
    {
        $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'laptop');
        $second = $this->driver()->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'phone');
        $this->assertSame(2, ExternalSession::query()->count());

        $user = $second->user;
        $request = Request::create('/api/v1/logout', 'POST');
        $request->headers->set('Authorization', 'Bearer '.$second->token);
        $request->setUserResolver(fn () => $user->withAccessToken(PersonalAccessToken::findToken((string) $second->token)));

        $this->driver()->logout($request);

        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertSame(1, $this->portal->calls('logout'));
        Http::assertSent(fn ($request): bool => str_ends_with($request->url(), '/auth/logout') && $request->hasHeader('Authorization', 'Bearer '.$this->portal->tokenFor('agent@test.local')));
        $this->assertSame(1, PersonalAccessToken::query()->count(), 'the other device keeps its token');
    }

    public function test_the_driver_never_calls_refresh_token(): void
    {
        [$user, , $context] = $this->signedIn();
        $this->travel(2)->minutes();
        $this->driver()->validateSession($user, $context);
        $this->driver()->logout(Request::create('/logout', 'POST'));

        Http::assertNotSent(fn ($request): bool => str_contains($request->url(), 'refresh-token'));
    }

    public function test_health_reports_ok_down_and_the_breaker(): void
    {
        $this->assertSame('ok', $this->driver()->health()->status, 'nothing observed yet counts as ok');

        [$user, , $context] = $this->signedIn();
        $this->assertSame('ok', $this->driver()->health()->status);
        $this->assertNotNull($this->driver()->health()->details['last_verify_at']);

        $this->portal->outage('connection');
        $this->travel(2)->minutes();
        $this->driver()->validateSession($user, $context);
        $this->assertSame('degraded', $this->driver()->health()->status);

        for ($i = 0; $i < 5; $i++) {
            $this->driver()->validateSession($user, $context);
        }

        $health = $this->driver()->health();
        $this->assertSame('down', $health->status);
        $this->assertTrue($health->details['circuit_open']);
    }
}
