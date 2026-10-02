<?php

namespace Tests\Feature\Auth;

use App\Models\AuditLog;
use App\Models\ExternalSession;
use App\Models\User;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Laravel\Fortify\LoginRateLimiter;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\AssertsOpenApi;
use Tests\Support\InteractsWithPortal;
use Tests\Support\InteractsWithStaffSignIn;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * `POST /api/v1/auth/token` in the external auth mode (mode 2): the portal checks the password and owns the roles; the app answers with its OWN
 * token bound to a portal session, never the portal's. Refusals look like the local ones, an unreachable portal is `503` (never `401`), and
 * nothing a portal could answer ever turns into a token by accident.
 */
class StaffSignInPortalTest extends TestCase
{
    use AssertsOpenApi, InteractsWithPortal, InteractsWithStaffSignIn, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()
            ->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')
            ->user('admin@test.local', 'admin-pass', 'admin', 'Test Admin')
            ->user('norole@test.local', 'norole-pass', 'norole', 'No Role')
            ->fake();
    }

    public function test_a_portal_account_signs_in_with_our_own_token_bound_to_a_portal_session(): void
    {
        $response = $this->signIn('agent@test.local', 'agent-pass', 'iPhone 17')->assertCreated();
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');

        $data = $response->json('data');
        $portalToken = $this->portal->tokenFor('agent@test.local');

        $this->assertSame('pizzasys', $data['mode']);
        $this->assertFalse($data['capabilities']['profileEditable']);
        $this->assertSame('pizzasys', $data['user']['auth_source']);
        $this->assertStringNotContainsString($portalToken, (string) $response->getContent(), 'the portal token never leaves the server');
        $this->assertStringNotContainsString(explode('|', $portalToken)[1], (string) $response->getContent());

        $token = PersonalAccessToken::findToken($data['token']);
        $this->assertSame(['staff'], $token->abilities);
        $this->assertSame('iPhone 17', $token->name);
        $this->assertSame($token->getKey(), ExternalSession::query()->sole()->sanctum_token_id, 'bound to the portal session');

        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->withToken($data['token'])->getJson('/api/v1/auth/me')->assertOk()->assertJsonPath('data.mode', 'pizzasys');
        $this->assertSame('pizzasys', AuditLog::query()->where('action', 'auth.token.issued')->sole()->changes['mode']);
    }

    public function test_roles_come_from_the_portal_and_an_administrator_signs_in_too(): void
    {
        $this->signIn('admin@test.local', 'admin-pass')->assertCreated()->assertJsonPath('data.user.is_admin', true);
    }

    public function test_wrong_password_and_unknown_email_are_one_answer_and_leave_no_session(): void
    {
        $wrong = $this->signIn('agent@test.local', 'nope')->assertUnauthorized();
        $unknown = $this->signIn('ghost@test.local', 'nope')->assertUnauthorized();

        $this->assertSame($wrong->json(), $unknown->json());
        $this->assertSame('invalid_credentials', $wrong->json('error.code'));
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertDatabaseCount('external_sessions', 0);
        foreach (['agent@test.local', 'ghost@test.local'] as $email) {
            $this->assertSame(1, app(LoginRateLimiter::class)->attempts(Request::create('/', 'POST', ['email' => $email], server: ['REMOTE_ADDR' => '127.0.0.1'])), 'each wrong password counts once');
        }
    }

    public function test_a_deactivated_portal_identity_gets_the_same_refusal(): void
    {
        $this->signIn('agent@test.local', 'agent-pass')->assertCreated();
        User::query()->where('email', 'agent@test.local')->firstOrFail()->forceFill(['is_active' => false])->save();
        $this->flushHeaders();

        $response = $this->signIn('agent@test.local', 'agent-pass')->assertUnauthorized();

        $this->assertSame('invalid_credentials', $response->json('error.code'));
        // Deactivating deleted the old token and no new one was issued.
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_a_person_the_portal_signed_in_but_who_has_no_chat_role_is_told_so(): void
    {
        $response = $this->signIn('norole@test.local', 'norole-pass')->assertForbidden();

        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');
        $this->assertSame('no_chat_access', $response->json('error.code'));
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertDatabaseCount('external_sessions', 0);
        $this->assertSame(1, $this->portal->calls('logout'), 'the portal token that was never used is closed again upstream');
        $this->assertSame('no_chat_access', AuditLog::query()->where('action', 'auth.token.failed')->sole()->changes['reason']);
    }

    public function test_an_unreachable_portal_is_503_with_retry_after_never_401_and_not_a_failed_password(): void
    {
        foreach (['connection', 'timeout', 'server_error', 'html', 'tls'] as $kind) {
            $this->portal->outage($kind);
            $this->flushHeaders();

            $response = $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.'.random_int(1, 200)])->signIn('agent@test.local', 'agent-pass')->assertStatus(503);

            $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');
            $this->assertSame('auth_unavailable', $response->json('error.code'), $kind);
            $this->assertSame('30', $response->headers->get('Retry-After'), $kind);
            $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        }

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $request = Request::create('/', 'POST', ['email' => 'agent@test.local'], server: ['REMOTE_ADDR' => '127.0.0.1']);
        $this->assertSame(0, app(LoginRateLimiter::class)->attempts($request), 'an outage is not a failed password');
        $this->assertSame(5, AuditLog::query()->where('action', 'auth.token.failed')->where('changes->reason', 'unavailable')->count());

        $this->portal->recover();
        $this->signIn('agent@test.local', 'agent-pass')->assertCreated();
    }

    public function test_the_unavailable_message_does_not_say_why(): void
    {
        $this->portal->rejectServiceCredential('Invalid service token.');

        $response = $this->signIn('agent@test.local', 'agent-pass')->assertStatus(503);

        $this->assertSame('auth_unavailable', $response->json('error.code'));
        foreach (['credential', 'portal', 'reject', 'token'] as $word) {
            $this->assertStringNotContainsStringIgnoringCase($word, (string) $response->getContent());
        }
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_an_unexpected_portal_answer_never_becomes_a_token_and_there_is_no_second_factor_step(): void
    {
        // The portal documented in docs/pizzasys-findings.md answers a login with a token or 401/422 only. Anything else (a 202 asking for
        // something we do not know, a 200 without a token) is "unavailable": fail closed, never a token.
        $http = new HttpFactory;
        $http->preventStrayRequests();
        Http::swap($http);
        Http::fake([PizzasysMock::BASE_URL.'/api/v1/auth/login' => Http::sequence()
            ->push(['two_factor' => true, 'challenge' => 'x'], 202)
            ->push(['data' => ['mfa' => 'required']], 200)
            ->push('', 204),
        ]);
        $this->portal->fake();

        for ($i = 0; $i < 3; $i++) {
            $this->flushHeaders();
            $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.'.($i + 1)])->signIn('agent@test.local', 'agent-pass')->assertStatus(503)->assertJsonPath('error.code', 'auth_unavailable');
        }

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertDatabaseCount('external_sessions', 0);
    }

    public function test_the_second_factor_step_has_nothing_to_answer_in_this_mode(): void
    {
        $this->answerChallenge('tfc_'.str_repeat('a', 40), '123456')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_challenge');
    }

    public function test_a_device_evicted_by_the_limit_loses_its_portal_session_too(): void
    {
        config(['staff_auth.max_tokens_per_user' => 2]);
        $this->signIn('agent@test.local', 'agent-pass', 'first')->assertCreated();
        $this->signIn('agent@test.local', 'agent-pass', 'second')->assertCreated();
        $this->assertSame(0, $this->portal->calls('logout'));

        $this->signIn('agent@test.local', 'agent-pass', 'third')->assertCreated();

        $this->assertSame(['second', 'third'], PersonalAccessToken::query()->orderBy('id')->pluck('name')->all());
        $this->assertSame(2, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertSame(1, ExternalSession::query()->whereNotNull('revoked_at')->count());
        $this->assertSame(1, $this->portal->calls('logout'), 'the evicted device is signed out at the portal');
    }

    public function test_a_throttled_portal_login_never_reaches_the_portal(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->signIn('agent@test.local', 'wrong')->assertUnauthorized();
        }

        $calls = $this->portal->calls('login');
        $this->signIn('agent@test.local', 'agent-pass')->assertTooManyRequests();

        $this->assertSame($calls, $this->portal->calls('login'));
    }
}
