<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Tokens\TwoFactorChallenges;
use App\Models\AuditLog;
use App\Models\StaffTwoFactorChallenge;
use App\Models\User;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\AssertsOpenApi;
use Tests\Support\InteractsWithPortal;
use Tests\Support\InteractsWithStaffSignIn;
use Tests\Support\PizzasysMock;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The second factor of a native sign-in (`POST /api/v1/auth/token/two-factor`) with local accounts. The point of the whole design: a right
 * password alone NEVER yields a token for an account with a second factor, a challenge belongs to one account, works once, burns after wrong
 * codes, and wrong codes count against the account, not only the challenge.
 */
class StaffSignInTwoFactorTest extends TestCase
{
    use AssertsOpenApi, InteractsWithPortal, InteractsWithStaffSignIn, RefreshDatabase, WidgetFixtures;

    private const PASSWORD = 'S3cret-Passw0rd-Not-In-Any-Log';

    private User $sam;

    /** @var array{secret: string, recovery: list<string>} */
    private array $factor;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->sam = User::factory()->agent()->create(['email' => 'sam@example.test', 'password' => self::PASSWORD]);
        $this->factor = $this->enrollTwoFactor($this->sam);
    }

    private function challenge(string $email = 'sam@example.test', string $device = 'Pixel 9'): string
    {
        $response = $this->signIn($email, self::PASSWORD, $device)->assertStatus(202);

        return (string) $response->json('data.challenge');
    }

    // ---- the password alone ------------------------------------------------------------------------------------------------------

    public function test_a_right_password_alone_never_yields_a_token_for_an_account_with_a_second_factor(): void
    {
        $response = $this->signIn('sam@example.test', self::PASSWORD, 'Pixel 9')->assertStatus(202);
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token');

        $data = $response->json('data');
        $this->assertTrue($data['twoFactor']);
        $this->assertMatchesRegularExpression('/^tfc_[A-Za-z0-9]{40}$/', $data['challenge']);
        $this->assertSame(['totp', 'recovery_code'], $data['methods']);
        $this->assertEqualsWithDelta(now()->addMinutes(5)->timestamp, strtotime($data['expiresAt']), 5);
        $this->assertArrayNotHasKey('token', $data);
        $this->assertStringNotContainsString('"token"', (string) $response->getContent());

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(1, AuditLog::query()->where('action', 'auth.token.two_factor_required')->count());
        $this->assertSame(0, AuditLog::query()->where('action', 'auth.token.issued')->count());
    }

    public function test_the_driver_itself_refuses_to_issue_a_token_for_a_second_factor_account(): void
    {
        $result = app(AuthDriver::class)->attemptForApi(['email' => 'sam@example.test', 'password' => self::PASSWORD], 'phone');

        $this->assertSame(AuthOutcome::TwoFactorRequired, $result->outcome);
        $this->assertNull($result->token);
        $this->assertTrue($this->sam->is($result->user));
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_a_second_factor_that_was_never_confirmed_is_not_required_exactly_like_the_dashboard(): void
    {
        $this->sam->forceFill(['two_factor_confirmed_at' => null])->save();

        $this->signIn('sam@example.test', self::PASSWORD)->assertCreated();
    }

    public function test_the_challenge_is_stored_hashed_and_bound_to_the_account_and_the_device(): void
    {
        $challenge = $this->challenge(device: 'Sam\'s Pixel 9');

        $row = StaffTwoFactorChallenge::query()->sole();
        $this->assertSame(hash('sha256', $challenge), $row->token_hash);
        $this->assertSame($this->sam->id, $row->user_id);
        $this->assertSame('Sam\'s Pixel 9', $row->device_name);
        $this->assertSame(0, $row->attempts);
        $this->assertNull($row->consumed_at);
        $this->assertSame([], DB::table('staff_two_factor_challenges')->where('token_hash', $challenge)->pluck('id')->all());
        $this->assertStringNotContainsString($challenge, (string) json_encode($row->makeVisible('token_hash')->toArray()));
    }

    // ---- completing it -------------------------------------------------------------------------------------------------------------

    public function test_the_authenticator_code_completes_the_sign_in_with_the_device_of_the_password_step(): void
    {
        $challenge = $this->challenge(device: 'Sam\'s Pixel 9');

        $response = $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertCreated();
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token/two-factor');

        $token = PersonalAccessToken::findToken($response->json('data.token'));
        $this->assertNotNull($token);
        $this->assertSame($this->sam->id, (int) $token->tokenable_id);
        $this->assertSame(['staff'], $token->abilities);
        $this->assertSame('Sam\'s Pixel 9', $token->name);
        $this->assertSame('Bearer', $response->json('data.tokenType'));
        $this->assertSame($this->sam->id, $response->json('data.user.id'));
        $this->assertNotNull(StaffTwoFactorChallenge::query()->sole()->consumed_at);

        $this->app['auth']->forgetGuards();
        $this->flushHeaders()->withToken($response->json('data.token'))->getJson('/api/v1/auth/me')->assertOk();

        $audit = AuditLog::query()->where('action', 'auth.token.issued')->sole();
        $this->assertSame('totp', $audit->changes['second_factor']);
        $this->assertSame($this->sam->id, $audit->actor_id);
    }

    public function test_a_recovery_code_completes_the_sign_in_once_and_is_replaced(): void
    {
        $codes = $this->factor['recovery'];
        $used = $codes[3];

        $this->answerChallenge($this->challenge(), recoveryCode: $used)->assertCreated();

        $after = $this->sam->fresh()->recoveryCodes();
        $this->assertCount(8, $after);
        $this->assertNotContains($used, $after, 'the used code is gone');
        $this->assertSame(array_values(array_diff($codes, [$used])), array_values(array_intersect($after, $codes)), 'the others are untouched');
        $this->assertSame('recovery_code', AuditLog::query()->where('action', 'auth.token.issued')->sole()->changes['second_factor']);

        // Single use: the same recovery code does not work a second time, for a new challenge either.
        $second = $this->answerChallenge($this->challenge(), recoveryCode: $used)->assertUnauthorized();
        $this->assertSame('invalid_two_factor_code', $second->json('error.code'));
        $this->assertDatabaseCount('personal_access_tokens', 1);
    }

    public function test_a_code_the_provider_already_accepted_is_not_accepted_again(): void
    {
        $first = $this->answerChallenge($this->challenge(), $code = $this->totp($this->factor['secret']))->assertCreated();
        $this->assertNotNull($first->json('data.token'));

        $this->answerChallenge($this->challenge(), $code)->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');
        $this->assertDatabaseCount('personal_access_tokens', 1);
    }

    // ---- challenge replay, expiry, ownership -----------------------------------------------------------------------------------------

    public function test_a_challenge_works_once(): void
    {
        $challenge = $this->challenge();

        $this->answerChallenge($challenge, $this->totp($this->factor['secret'], -1))->assertCreated();
        $replay = $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertUnauthorized();

        $this->assertMatchesOpenApi($replay, ApiAudience::Management, 'POST', '/api/v1/auth/token/two-factor');
        $this->assertSame('invalid_challenge', $replay->json('error.code'));
        $this->assertDatabaseCount('personal_access_tokens', 1);
    }

    public function test_two_calls_cannot_both_use_the_same_challenge_up(): void
    {
        $challenges = app(TwoFactorChallenges::class);
        $challenge = $challenges->find($this->challenge());

        $this->assertTrue($challenges->consume($challenge));
        $this->assertFalse($challenges->consume($challenge), 'the guarded UPDATE lets exactly one caller win');
        $this->assertNull($challenges->find('tfc_'.str_repeat('x', 40)));
    }

    public function test_an_expired_challenge_is_refused_with_a_right_code(): void
    {
        $challenge = $this->challenge();

        $this->travel(5)->minutes();
        $this->travel(1)->seconds();

        $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertUnauthorized()->assertJsonPath('error.code', 'invalid_challenge');
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_a_challenge_issued_for_one_account_cannot_be_used_for_another(): void
    {
        $other = User::factory()->agent()->create(['email' => 'alex@example.test', 'password' => self::PASSWORD]);
        $otherFactor = $this->enrollTwoFactor($other);

        $samsChallenge = $this->challenge('sam@example.test');
        $alexChallenge = $this->challenge('alex@example.test');

        // Alex's valid code against Sam's challenge: wrong (the account is Sam's), counted against Sam's challenge, no token for anyone.
        $this->answerChallenge($samsChallenge, $this->totp($otherFactor['secret']))->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');
        $this->assertSame(1, StaffTwoFactorChallenge::query()->where('user_id', $this->sam->id)->sole()->attempts);
        $this->assertDatabaseCount('personal_access_tokens', 0);

        // Nothing in the call names an account, so extra fields change nothing.
        $this->postJson('/api/v1/auth/token/two-factor', ['challenge' => $samsChallenge, 'code' => $this->totp($otherFactor['secret']), 'email' => 'alex@example.test', 'user_id' => $other->id, 'device_name' => 'Spoof'])->assertUnauthorized();

        // Each challenge signs in exactly its own account.
        $own = $this->answerChallenge($alexChallenge, $this->totp($otherFactor['secret']))->assertCreated();
        $this->assertSame($other->id, $own->json('data.user.id'));
        $this->assertSame($other->id, (int) PersonalAccessToken::findToken($own->json('data.token'))->tokenable_id);
        $this->assertSame(0, PersonalAccessToken::query()->where('tokenable_id', $this->sam->id)->count());
    }

    public function test_made_up_challenges_are_refused_the_same_way_whatever_they_look_like(): void
    {
        $this->challenge();

        foreach (['tfc_'.str_repeat('a', 40), str_repeat('z', 44), 'tfc_'.str_repeat('0', 40), substr(hash('sha256', 'x'), 0, 44)] as $made) {
            $this->answerChallenge($made, $this->totp($this->factor['secret']))->assertUnauthorized()->assertJsonPath('error.code', 'invalid_challenge');
        }

        $this->postJson('/api/v1/auth/token/two-factor', ['code' => '123456'])->assertUnprocessable();
        $this->postJson('/api/v1/auth/token/two-factor', ['challenge' => 'short', 'code' => '123456'])->assertUnprocessable();
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    public function test_a_challenge_stops_working_when_the_account_stops_being_able_to_sign_in(): void
    {
        foreach ([
            'deactivated' => fn () => $this->sam->forceFill(['is_active' => false])->save(),
            'role removed' => fn () => $this->sam->forceFill(['is_agent' => false, 'is_admin' => false])->save(),
            'second factor switched off' => fn () => $this->sam->forceFill(['two_factor_secret' => null, 'two_factor_recovery_codes' => null, 'two_factor_confirmed_at' => null])->save(),
        ] as $label => $change) {
            $this->sam->forceFill(['is_active' => true, 'is_agent' => true, 'two_factor_secret' => encrypt($this->factor['secret']), 'two_factor_recovery_codes' => encrypt(json_encode($this->factor['recovery'])), 'two_factor_confirmed_at' => now()])->save();
            $challenge = $this->challenge();

            $change();

            $response = $this->answerChallenge($challenge, $this->totp($this->factor['secret']));
            $this->assertSame(401, $response->getStatusCode(), $label);
            $this->assertSame('invalid_challenge', $response->json('error.code'), $label);
            $this->assertDatabaseCount('personal_access_tokens', 0);
        }
    }

    public function test_a_challenge_does_not_survive_a_switch_to_the_external_auth_mode(): void
    {
        $challenge = $this->challenge();
        $this->usePortalMode();
        PizzasysMock::make()->fake();

        $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertUnauthorized()->assertJsonPath('error.code', 'invalid_challenge');
        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    // ---- wrong codes -----------------------------------------------------------------------------------------------------------------

    public function test_wrong_codes_count_down_and_burn_the_challenge_even_for_the_right_code_afterwards(): void
    {
        $challenge = $this->challenge();
        $wrong = $this->wrongTotp($this->factor['secret']);

        foreach ([4, 3, 2, 1, 0] as $remaining) {
            $response = $this->answerChallenge($challenge, $wrong)->assertUnauthorized();

            $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token/two-factor');
            $this->assertSame('invalid_two_factor_code', $response->json('error.code'));
            $this->assertSame($remaining, $response->json('error.details.attempts_remaining'));
        }

        $burnt = $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertUnauthorized();
        $this->assertSame('invalid_challenge', $burnt->json('error.code'), 'burnt: not even the right code works now');
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(5, AuditLog::query()->where('action', 'auth.token.two_factor_failed')->where('changes->reason', 'wrong_code')->count());
    }

    public function test_a_wrong_recovery_code_is_just_a_wrong_code_and_spends_nothing(): void
    {
        $this->answerChallenge($this->challenge(), recoveryCode: 'AAAAAAAAAA-BBBBBBBBBB')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');

        $this->assertSame($this->factor['recovery'], $this->sam->fresh()->recoveryCodes());
    }

    public function test_wrong_codes_are_counted_against_the_account_so_a_new_challenge_brings_no_fresh_budget(): void
    {
        config(['staff_auth.two_factor.challenge_attempts' => 3, 'staff_auth.two_factor.per_user_per_minute' => 4]);
        $wrong = $this->wrongTotp($this->factor['secret']);

        $first = $this->challenge();
        for ($i = 0; $i < 3; $i++) {
            $this->answerChallenge($first, $wrong)->assertUnauthorized();
        }

        // A fresh challenge (the password was right again), one more wrong code: the account has now had four.
        $second = $this->challenge();
        $this->answerChallenge($second, $wrong)->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');

        // Locked: even the right code is refused, and says when to come back.
        $locked = $this->answerChallenge($second, $this->totp($this->factor['secret']))->assertTooManyRequests();

        $this->assertMatchesOpenApi($locked, ApiAudience::Management, 'POST', '/api/v1/auth/token/two-factor');
        $this->assertSame('rate_limited', $locked->json('error.code'));
        $this->assertGreaterThan(0, (int) $locked->headers->get('Retry-After'));
        $this->assertStringContainsString('no-store', (string) $locked->headers->get('Cache-Control'));
        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(1, AuditLog::query()->where('changes->reason', 'locked')->count());

        $this->travel(61)->seconds();
        $this->answerChallenge($second, $this->totp($this->factor['secret']))->assertCreated();
    }

    public function test_a_success_forgives_the_wrong_codes_of_the_account(): void
    {
        $challenge = $this->challenge();
        $this->answerChallenge($challenge, $this->wrongTotp($this->factor['secret']))->assertUnauthorized();
        $this->answerChallenge($challenge, $this->totp($this->factor['secret']))->assertCreated();

        $this->assertFalse(RateLimiter::tooManyAttempts('staff-2fa-failed:minute:'.$this->sam->id, 1));
        $this->assertSame(0, RateLimiter::attempts('staff-2fa-failed:minute:'.$this->sam->id));
    }

    public function test_one_challenge_value_and_one_address_cannot_be_hammered_with_calls(): void
    {
        $made = 'tfc_'.str_repeat('q', 40);

        for ($i = 1; $i <= 10; $i++) {
            $this->answerChallenge($made, '123456')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_challenge');
        }

        $response = $this->answerChallenge($made, '123456')->assertTooManyRequests();
        $this->assertMatchesOpenApi($response, ApiAudience::Management, 'POST', '/api/v1/auth/token/two-factor');
        $this->assertGreaterThan(0, (int) $response->headers->get('Retry-After'));

        // A different value from the same address still passes the per-challenge limit, but the per-address one is 30 a minute (the refused call above did not count).
        for ($i = 1; $i <= 20; $i++) {
            $this->answerChallenge('tfc_'.str_pad((string) $i, 40, 'r'), '123456')->assertUnauthorized();
        }

        $this->answerChallenge('tfc_'.str_repeat('s', 40), '123456')->assertTooManyRequests();
        $this->withServerVariables(['REMOTE_ADDR' => '198.51.100.20'])->answerChallenge('tfc_'.str_repeat('s', 40), '123456')->assertUnauthorized();
    }

    // ---- the shape of the call -------------------------------------------------------------------------------------------------------

    public function test_exactly_one_second_factor_is_required(): void
    {
        $challenge = $this->challenge();

        $this->postJson('/api/v1/auth/token/two-factor', ['challenge' => $challenge])->assertUnprocessable()->assertJsonStructure(['error' => ['details' => ['code']]]);
        $this->postJson('/api/v1/auth/token/two-factor', ['challenge' => $challenge, 'code' => '123456', 'recovery_code' => 'x'])->assertUnprocessable();
        $this->postJson('/api/v1/auth/token/two-factor', ['challenge' => $challenge, 'code' => ['123456']])->assertUnprocessable();

        $this->assertDatabaseCount('personal_access_tokens', 0);
        $this->assertSame(0, StaffTwoFactorChallenge::query()->sole()->attempts, 'a malformed call is not a wrong code');
    }

    public function test_the_authenticator_code_may_be_typed_with_spaces_and_nothing_else_passes(): void
    {
        $code = $this->totp($this->factor['secret']);
        $spaced = substr($code, 0, 3).' '.substr($code, 3);

        $this->answerChallenge($this->challenge(), $spaced)->assertCreated();
        $this->answerChallenge($this->challenge(), "1' OR '1'='1")->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');
        $this->answerChallenge($this->challenge(), '00000000000')->assertUnauthorized()->assertJsonPath('error.code', 'invalid_two_factor_code');
        $this->answerChallenge($this->challenge(), str_repeat('1', 17))->assertUnprocessable();
    }

    public function test_old_challenges_are_pruned_with_the_daily_session_prune(): void
    {
        $challenges = app(TwoFactorChallenges::class);
        $challenges->issue($this->sam, 'live', null);

        foreach ([now()->subDays(2), now()->subDays(3), now()->subHours(2)] as $expiredAt) {
            StaffTwoFactorChallenge::query()->create(['token_hash' => hash('sha256', (string) $expiredAt->timestamp), 'user_id' => $this->sam->id, 'device_name' => 'old', 'expires_at' => $expiredAt]);
        }

        $this->assertSame(2, $challenges->prune(), 'expired for more than a day');
        $this->assertDatabaseCount('staff_two_factor_challenges', 2);
    }

    public function test_issuing_a_challenge_tidies_up_the_expired_ones_of_that_account(): void
    {
        $this->challenge();
        $this->travel(10)->minutes();
        $this->challenge();

        $this->assertDatabaseCount('staff_two_factor_challenges', 1);
    }

    public function test_a_device_over_the_limit_is_evicted_after_a_second_factor_sign_in_too(): void
    {
        config(['staff_auth.max_tokens_per_user' => 1]);
        $this->sam->createToken('old', ['staff']);

        $this->answerChallenge($this->challenge(device: 'New'), $this->totp($this->factor['secret']))->assertCreated();

        $this->assertSame(['New'], PersonalAccessToken::query()->pluck('name')->all());
    }
}
