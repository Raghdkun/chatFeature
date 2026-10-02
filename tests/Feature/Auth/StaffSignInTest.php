<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Tokens\DeviceName;
use App\Domain\Audit\AuditLogger;
use App\Http\Middleware\Auth\LimitRequestBodySize;
use App\Http\Middleware\Auth\NoStoreResponses;
use App\Http\Middleware\Chat\ChatThrottle;
use App\Models\AuditLog;
use App\Models\User;
use App\Support\ApiDocs\ApiAudience;
use App\Support\ApiDocs\ApiRoutes;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Laravel\Fortify\LoginRateLimiter;
use Laravel\Sanctum\Http\Middleware\EnsureFrontendRequestsAreStateful;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\AssertsOpenApi;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithStaffSignIn;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `POST /api/v1/auth/token` with local accounts (mode 1): the one unauthenticated management endpoint. What it must get right: a token that
 * works for a right password, ONE answer for every refusal (and the same hash work), the dashboard's throttle budget, nothing stateful, nothing
 * cached, nothing secret in the audit log, and a bounded number of signed-in devices. The second factor is in StaffSignInTwoFactorTest, the
 * external auth portal in StaffSignInPortalTest.
 */
class StaffSignInTest extends TestCase
{
    use AssertsOpenApi, InteractsWithStaffSignIn, RefreshDatabase, WidgetFixtures;

    private const PASSWORD = 'S3cret-Passw0rd-Not-In-Any-Log';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    private function agent(string $email = 'sam@example.test'): User
    {
        return User::factory()->agent()->create(['email' => $email, 'password' => self::PASSWORD]);
    }

    // ---- success -------------------------------------------------------------------------------------------------------------------

    public function test_a_right_password_signs_in_and_the_token_works_everywhere_a_staff_token_does(): void
    {
        $agent = $this->agent();

        $response = $this->signIn('sam@example.test', self::PASSWORD, 'Sam\'s Pixel 9')->assertCreated();
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');

        $data = $response->json('data');
        $this->assertSame('Bearer', $data['tokenType']);
        $this->assertSame($agent->id, $data['user']['id']);
        $this->assertSame('fortify', $data['mode']);
        $this->assertTrue($data['capabilities']['profileEditable']);
        $this->assertNull($data['realtime']);
        $this->assertEqualsWithDelta(now()->addMinutes((int) config('sanctum.expiration'))->timestamp, strtotime($data['expiresAt']), 5);
        $this->assertEqualsWithDelta(now()->timestamp, strtotime($data['serverTime']), 5);
        $this->assertStringNotContainsString('password', (string) $response->getContent());

        // Our own Sanctum token: abilities, label, stored hashed.
        $stored = PersonalAccessToken::findToken($data['token']);
        $this->assertNotNull($stored);
        $this->assertSame(['staff'], $stored->abilities);
        $this->assertSame('Sam\'s Pixel 9', $stored->name);
        $this->assertSame($agent->id, (int) $stored->tokenable_id);
        $this->assertSame(hash('sha256', explode('|', $data['token'])[1]), $stored->token);
        $this->assertDatabaseMissing('personal_access_tokens', ['token' => explode('|', $data['token'])[1]]);

        $this->app['auth']->forgetGuards();
        $me = $this->flushHeaders()->withToken($data['token'])->getJson('/api/v1/auth/me')->assertOk();
        $this->assertTrue($me->json('data.token.current'));
        $this->assertSame('Sam\'s Pixel 9', $me->json('data.token.name'));
    }

    public function test_an_administrator_signs_in_too_and_the_email_is_case_insensitive(): void
    {
        $admin = User::factory()->admin()->create(['email' => 'boss@example.test', 'password' => self::PASSWORD]);

        $this->signIn('  BOSS@Example.test ', self::PASSWORD)->assertCreated()->assertJsonPath('data.user.id', $admin->id)->assertJsonPath('data.user.is_admin', true);
    }

    public function test_signing_in_keeps_the_signed_in_devices_apart_and_logout_and_the_token_list_work_with_it(): void
    {
        $this->agent();

        $phone = $this->signIn('sam@example.test', self::PASSWORD, 'Pixel 9')->assertCreated()->json('data.token');
        $tablet = $this->signIn('sam@example.test', self::PASSWORD, 'iPad')->assertCreated()->json('data.token');

        $this->app['auth']->forgetGuards();
        $list = $this->flushHeaders()->withToken($tablet)->getJson('/api/v1/auth/tokens')->assertOk();
        $this->assertSame(['iPad', 'Pixel 9'], array_column($list->json('data'), 'name'));
        $this->assertSame([true, false], array_column($list->json('data'), 'current'));

        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->withToken($tablet)->postJson('/api/v1/auth/logout')->assertNoContent();

        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->withToken($tablet)->getJson('/api/v1/auth/me')->assertUnauthorized();
        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->withToken($phone)->getJson('/api/v1/auth/me')->assertOk();
    }

    // ---- refusals: one answer ------------------------------------------------------------------------------------------------------

    public function test_every_refusal_is_the_same_answer_and_never_leaves_a_token(): void
    {
        $this->agent('real@example.test');
        User::factory()->agent()->inactive()->create(['email' => 'gone@example.test', 'password' => self::PASSWORD]);
        User::factory()->withoutChatAccess()->create(['email' => 'visitor@example.test', 'password' => self::PASSWORD]);
        User::factory()->agent()->create(['email' => 'portal@example.test', 'password' => null]);

        $answers = [];

        foreach ([
            'unknown email' => ['nobody@example.test', self::PASSWORD],
            'wrong password' => ['real@example.test', 'not-the-password'],
            'deactivated, right password' => ['gone@example.test', self::PASSWORD],
            'no chat role, right password' => ['visitor@example.test', self::PASSWORD],
            'no local password at all' => ['portal@example.test', self::PASSWORD],
        ] as $label => [$email, $password]) {
            $response = $this->signIn($email, $password)->assertUnauthorized();
            $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');
            $answers[$label] = [$response->json(), $response->headers->get('Cache-Control')];
        }

        $this->assertCount(1, array_unique(array_map('serialize', $answers)), 'one body and one set of headers for every refusal: '.json_encode($answers));
        $this->assertSame('invalid_credentials', $answers['unknown email'][0]['error']['code']);
        $this->assertArrayNotHasKey('details', $answers['unknown email'][0]['error']);
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(0, AuditLog::query()->where('action', 'auth.token.issued')->count());
    }

    public function test_a_refusal_spends_the_hash_work_of_a_real_check_whatever_was_wrong(): void
    {
        $this->agent('real@example.test');
        User::factory()->agent()->inactive()->create(['email' => 'gone@example.test', 'password' => self::PASSWORD]);
        User::factory()->withoutChatAccess()->create(['email' => 'visitor@example.test', 'password' => self::PASSWORD]);
        User::factory()->agent()->create(['email' => 'portal@example.test', 'password' => null]);
        $hasher = $this->countHashChecks();

        foreach ([
            ['real@example.test', self::PASSWORD],
            ['real@example.test', 'wrong'],
            ['nobody@example.test', self::PASSWORD],
            ['gone@example.test', self::PASSWORD],
            ['visitor@example.test', self::PASSWORD],
            ['portal@example.test', self::PASSWORD],
        ] as $index => [$email, $password]) {
            $before = $hasher->checks;
            $this->signIn($email, $password);

            $this->assertSame(1, $hasher->checks - $before, "attempt #{$index} ({$email}) must run exactly one password hash check, a real one or the stand-in");
        }
    }

    public function test_the_driver_never_hands_out_a_token_to_an_account_that_cannot_have_one(): void
    {
        User::factory()->agent()->inactive()->create(['email' => 'gone@example.test', 'password' => self::PASSWORD]);

        $result = app(AuthDriver::class)->attemptForApi(['email' => 'gone@example.test', 'password' => self::PASSWORD], 'phone');

        $this->assertSame(AuthOutcome::Invalid, $result->outcome);
        $this->assertNull($result->token);
    }

    // ---- validation and size -------------------------------------------------------------------------------------------------------

    public function test_malformed_bodies_are_validation_errors_not_authentication_attempts(): void
    {
        $this->agent();

        $this->postJson('/api/v1/auth/token', [])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['email', 'password', 'device_name']]]);
        $this->postJson('/api/v1/auth/token', ['email' => 'not-an-email', 'password' => 'x', 'device_name' => 'Pixel'])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['email']]]);
        $this->postJson('/api/v1/auth/token', ['email' => ['sam@example.test'], 'password' => ['x'], 'device_name' => 'Pixel'])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['email', 'password']]]);
        $this->postJson('/api/v1/auth/token', ['email' => 'sam@example.test', 'password' => str_repeat('p', 1025), 'device_name' => 'Pixel'])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['password']]]);
        $this->postJson('/api/v1/auth/token', ['email' => 'sam@example.test', 'password' => self::PASSWORD, 'device_name' => " \u{202E}<> \t"])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['device_name']]]);
        $this->postJson('/api/v1/auth/token', ['email' => 'sam@example.test', 'password' => self::PASSWORD, 'device_name' => 'ab'])->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['device_name']]]);

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(0, app(LoginRateLimiter::class)->attempts($this->makeRequest()), 'a malformed call is not a failed password');
    }

    public function test_a_body_over_the_cap_is_refused_before_it_is_read(): void
    {
        $response = $this->postJson('/api/v1/auth/token', ['email' => 'sam@example.test', 'password' => str_repeat('p', 9000), 'device_name' => 'Pixel 9']);

        $response->assertStatus(413)->assertJsonPath('error.code', 'payload_too_large');
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
    }

    public function test_the_device_name_is_made_harmless_and_short(): void
    {
        $this->agent();

        $dirty = "Sam's\u{202E} <b>Pixel</b>\u{0000}\n\t9 \u{200B}".str_repeat('x', 100);
        $this->signIn('sam@example.test', self::PASSWORD, $dirty)->assertCreated();

        $name = PersonalAccessToken::query()->sole()->name;

        $this->assertLessThanOrEqual(DeviceName::MAX_LENGTH, mb_strlen($name));
        $this->assertStringStartsWith('Sam\'s b Pixel /b 9 xxx', $name);
        $this->assertDoesNotMatchRegularExpression('/[\p{Cc}\p{Cf}<>]/u', $name);
    }

    public function test_device_names_are_cleaned_by_one_rule(): void
    {
        $this->assertSame('Pixel 9', DeviceName::clean("  Pixel \n\t 9  "));
        $this->assertSame('Sam iPhone', DeviceName::clean("Sam\u{200F}\u{202E} iPhone"));
        $this->assertSame('', DeviceName::clean("\xC3\x28 invalid utf8"));
        $this->assertSame(60, mb_strlen(DeviceName::clean(str_repeat('é', 200))));
        $this->assertSame('iPhone Sam', DeviceName::clean('iPhone <Sam>'));
    }

    // ---- throttling ----------------------------------------------------------------------------------------------------------------

    public function test_wrong_passwords_are_throttled_and_the_answer_is_the_documented_envelope(): void
    {
        $this->agent();

        for ($attempt = 1; $attempt <= 5; $attempt++) {
            $this->signIn('sam@example.test', 'wrong-'.$attempt)->assertUnauthorized();
        }

        // The right password does not get past the lock-out either.
        $response = $this->signIn('sam@example.test', self::PASSWORD)->assertTooManyRequests();

        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');
        $this->assertSame('rate_limited', $response->json('error.code'));
        $this->assertGreaterThan(0, (int) $response->headers->get('Retry-After'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_the_failed_attempt_lock_out_is_checked_before_the_password_is_looked_at(): void
    {
        $this->agent();
        $key = $this->makeRequest();

        // Five failures recorded elsewhere (the dashboard login uses the very same counter).
        for ($i = 0; $i < 5; $i++) {
            app(LoginRateLimiter::class)->increment($key);
        }

        $hasher = $this->countHashChecks();
        $response = $this->signIn('sam@example.test', self::PASSWORD)->assertTooManyRequests();

        $this->assertSame('rate_limited', $response->json('error.code'));
        $this->assertGreaterThan(0, (int) $response->headers->get('Retry-After'));
        $this->assertSame(0, $hasher->checks, 'a locked key never reaches the password check');
    }

    public function test_a_success_clears_the_failed_attempts_of_that_email_and_address(): void
    {
        $this->agent();

        $this->signIn('sam@example.test', 'wrong')->assertUnauthorized();
        $this->signIn('sam@example.test', 'wrong')->assertUnauthorized();
        $this->assertSame(2, app(LoginRateLimiter::class)->attempts($this->makeRequest()));

        $this->signIn('sam@example.test', self::PASSWORD)->assertCreated();

        $this->assertSame(0, app(LoginRateLimiter::class)->attempts($this->makeRequest()));
    }

    public function test_the_dashboard_login_and_the_app_share_one_budget_per_account(): void
    {
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        $this->agent();

        // Three wrong passwords at the dashboard, two at the app: five attempts of one email from one address.
        for ($i = 0; $i < 3; $i++) {
            $this->post(route('login.store'), ['email' => 'sam@example.test', 'password' => 'wrong'])->assertSessionHasErrors('email');
        }

        for ($i = 0; $i < 2; $i++) {
            $this->signIn('sam@example.test', 'wrong')->assertUnauthorized();
        }

        // Out of budget for both doors, with the right password.
        $this->signIn('sam@example.test', self::PASSWORD)->assertTooManyRequests();
        $this->post(route('login.store'), ['email' => 'sam@example.test', 'password' => self::PASSWORD])->assertTooManyRequests();
    }

    public function test_one_address_cannot_spray_unlimited_emails_at_the_app(): void
    {
        for ($i = 1; $i <= 30; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->signIn("user{$i}@example.test", 'x')->assertUnauthorized();
        }

        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.9'])->signIn('user31@example.test', 'x')->assertTooManyRequests();
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.10'])->signIn('user1@example.test', 'x')->assertUnauthorized();
    }

    public function test_one_account_cannot_be_attacked_from_unlimited_addresses_at_the_app(): void
    {
        for ($i = 1; $i <= 10; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => "203.0.113.{$i}"])->signIn('victim@example.test', 'x')->assertUnauthorized();
        }

        $this->withServerVariables(['REMOTE_ADDR' => '198.51.100.77'])->signIn('victim@example.test', 'x')->assertTooManyRequests();
        $this->withServerVariables(['REMOTE_ADDR' => '198.51.100.77'])->signIn('another@example.test', 'x')->assertUnauthorized();
    }

    // ---- nothing stateful, nothing cached ------------------------------------------------------------------------------------------

    public function test_no_answer_sets_a_cookie_starts_a_session_or_opens_up_cors_and_every_answer_is_uncacheable(): void
    {
        $this->agent();
        $origin = rtrim((string) config('app.url'), '/');

        $headers = ['Origin' => $origin, 'Referer' => $origin.'/dashboard', 'Cookie' => 'laravel_session=abc; remember_web_x=def; XSRF-TOKEN=ghi'];
        $calls = [
            'created' => fn () => $this->withHeaders($headers)->signIn('sam@example.test', self::PASSWORD),
            'refused' => fn () => $this->withHeaders($headers)->signIn('sam@example.test', 'nope'),
            'invalid' => fn () => $this->withHeaders($headers)->postJson('/api/v1/auth/token', []),
            'challenge step' => fn () => $this->withHeaders($headers)->answerChallenge(str_repeat('a', 44), '123456'),
        ];

        foreach ($calls as $label => $call) {
            $response = $call();

            $this->assertContains($response->getStatusCode(), [201, 401, 422], $label);
            $this->assertSame([], $response->headers->getCookies(), "{$label}: no cookie");
            $this->assertNull($response->headers->get('Set-Cookie'), "{$label}: no Set-Cookie");
            $this->assertNull($response->headers->get('Access-Control-Allow-Origin'), "{$label}: no CORS");
            $this->assertNull($response->headers->get('Access-Control-Allow-Credentials'), "{$label}: no CORS credentials");
            $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'), "{$label}: no-store");
            $this->assertSame('no-cache', $response->headers->get('Pragma'), $label);
        }
    }

    public function test_a_preflight_is_not_answered_with_cors_headers(): void
    {
        $response = $this->call('OPTIONS', '/api/v1/auth/token', [], [], [], ['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => 'POST']);

        $this->assertNull($response->headers->get('Access-Control-Allow-Origin'));
        $this->assertNull($response->headers->get('Access-Control-Allow-Methods'));
    }

    public function test_signing_in_leaves_the_web_guard_signed_out(): void
    {
        $this->agent();

        $this->signIn('sam@example.test', self::PASSWORD)->assertCreated();

        $this->assertGuest('web');
    }

    public function test_the_gate_of_an_uninstalled_application_answers_before_anything_else(): void
    {
        InstallStateFake::make(installed: false);

        $this->signIn('sam@example.test', self::PASSWORD)->assertStatus(503)->assertExactJson(['error' => 'not_installed']);
    }

    // ---- device limit --------------------------------------------------------------------------------------------------------------

    public function test_a_user_keeps_at_most_the_configured_number_of_devices_and_the_least_recently_used_goes_first(): void
    {
        config(['staff_auth.max_tokens_per_user' => 3]);
        $agent = $this->agent();

        $oldUnused = $agent->createToken('old and unused', ['staff'])->accessToken;
        $oldUnused->forceFill(['created_at' => now()->subDays(10)])->save();
        $oldButBusy = $agent->createToken('old but in use', ['staff'])->accessToken;
        $oldButBusy->forceFill(['created_at' => now()->subDays(9), 'last_used_at' => now()->subMinute()])->save();
        $recent = $agent->createToken('recent', ['staff'])->accessToken;

        $this->signIn('sam@example.test', self::PASSWORD, 'New phone')->assertCreated();

        $names = PersonalAccessToken::query()->pluck('name')->sort()->values()->all();
        $this->assertSame(['New phone', 'old but in use', 'recent'], $names, 'three devices: the one used least recently went');
        $this->assertSame(1, AuditLog::query()->where('action', 'auth.token.issued')->sole()->changes['evicted_devices']);
        $this->assertNotNull($recent->fresh());
    }

    public function test_the_new_token_is_never_the_one_that_is_evicted_and_expired_tokens_go_first(): void
    {
        config(['staff_auth.max_tokens_per_user' => 1, 'sanctum.expiration' => 60]);
        $agent = $this->agent();
        $agent->createToken('expired', ['staff'])->accessToken->forceFill(['created_at' => now()->subHours(3)])->save();
        $agent->createToken('live', ['staff']);

        $token = $this->signIn('sam@example.test', self::PASSWORD, 'Fresh')->assertCreated()->json('data.token');

        $this->assertSame(['Fresh'], PersonalAccessToken::query()->pluck('name')->all());
        $this->assertNotNull(PersonalAccessToken::findToken($token));
    }

    // ---- audit ---------------------------------------------------------------------------------------------------------------------

    public function test_the_audit_log_records_success_and_failure_and_never_a_secret(): void
    {
        $this->agent();

        $token = $this->signIn('sam@example.test', 'wrong-password-value')->assertUnauthorized();
        $issued = $this->signIn('sam@example.test', self::PASSWORD, 'Pixel 9')->assertCreated()->json('data.token');

        $failed = AuditLog::query()->where('action', 'auth.token.failed')->sole();
        $this->assertSame(['mode' => 'fortify', 'reason' => 'invalid_credentials', 'email' => 'sam@example.test', 'device_name' => 'Pixel 9'], $failed->changes);
        $this->assertNull($failed->actor_id);
        $this->assertNotNull($failed->ip_address);

        $row = AuditLog::query()->where('action', 'auth.token.issued')->sole();
        $this->assertSame('fortify', $row->changes['mode']);
        $this->assertSame('Pixel 9', $row->changes['device_name']);
        $this->assertNull($row->changes['second_factor']);
        $this->assertSame(PersonalAccessToken::class, $row->subject_type);
        $this->assertSame((string) PersonalAccessToken::findToken($issued)->getKey(), $row->subject_id);
        $this->assertSame(User::query()->value('id'), $row->actor_id);

        $everything = json_encode(AuditLog::query()->get()->toArray());
        foreach ([self::PASSWORD, 'wrong-password-value', explode('|', $issued)[1], $issued] as $secret) {
            $this->assertStringNotContainsString($secret, (string) $everything);
        }
    }

    public function test_failed_attempts_cannot_flood_the_audit_log(): void
    {
        config(['staff_auth.audit_failures_per_minute' => 3]);

        for ($i = 1; $i <= 6; $i++) {
            $this->withServerVariables(['REMOTE_ADDR' => "203.0.113.{$i}"])->signIn("ghost{$i}@example.test", 'x')->assertUnauthorized();
        }

        $this->assertSame(3, AuditLog::query()->where('action', 'auth.token.failed')->count());
        $this->assertSame(1, AuditLog::query()->where('action', 'auth.token.failure_flood')->count(), 'one summary row, not one per refused attempt');

        $this->travel(61)->seconds();
        RateLimiter::clear('staff-sign-in:audit-failures');
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.99'])->signIn('ghost99@example.test', 'x')->assertUnauthorized();

        $this->assertSame(4, AuditLog::query()->where('action', 'auth.token.failed')->count());
    }

    public function test_the_audit_logger_redacts_second_factor_keys_too(): void
    {
        $row = app(AuditLogger::class)->record('probe', null, ['recovery_code' => 'abc', 'challenge' => 'tfc_x', 'code' => '123456', 'error_code' => 'keep', 'nested' => ['code' => '654321', 'password' => 'p']]);

        $this->assertSame('[redacted]', $row->changes['recovery_code']);
        $this->assertSame('[redacted]', $row->changes['challenge']);
        $this->assertSame('[redacted]', $row->changes['code']);
        $this->assertSame('keep', $row->changes['error_code'], 'only an exact `code` is a secret, not every key that ends in it');
        $this->assertSame(['code' => '[redacted]', 'password' => '[redacted]'], $row->changes['nested']);
    }

    // ---- route classification ------------------------------------------------------------------------------------------------------

    public function test_the_sign_in_routes_are_the_only_unauthenticated_routes_of_the_management_api(): void
    {
        $unauthenticated = [];

        foreach (ApiRoutes::forAudience(ApiAudience::Management) as $route) {
            if (str_starts_with($route->uri(), 'webhooks/')) {
                continue;
            }

            if (! ApiRoutes::hasMiddleware($route, 'auth') && ! ApiRoutes::hasMiddleware($route, 'signed')) {
                $unauthenticated[] = ApiRoutes::label($route);
            }
        }

        sort($unauthenticated);
        $this->assertSame(['POST /api/v1/auth/token', 'POST /api/v1/auth/token/two-factor'], $unauthenticated);
    }

    public function test_the_sign_in_routes_carry_exactly_the_guards_the_threat_model_relies_on(): void
    {
        $router = $this->app['router'];

        foreach (['api.auth.token.store' => 'login', 'api.auth.token.two-factor' => 'staff-two-factor'] as $name => $limiter) {
            $route = $router->getRoutes()->getByName($name);
            $resolved = $router->gatherRouteMiddleware($route);

            $this->assertContains(NoStoreResponses::class, $resolved);
            $this->assertContains(LimitRequestBodySize::class, $resolved);
            $this->assertContains(ChatThrottle::class.':'.$limiter, $resolved);
            $this->assertNotContains(EnsureFrontendRequestsAreStateful::class, $resolved, 'stateless: no session, no cookie');
            $this->assertSame(['POST'], $route->methods());
        }
    }

    /** A request that carries the email and address of the calls above, to read the lock-out counter of that key. */
    private function makeRequest(): Request
    {
        return Request::create('/api/v1/auth/token', 'POST', ['email' => 'sam@example.test'], server: ['REMOTE_ADDR' => '127.0.0.1']);
    }
}
