<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\AuthEnvironment;
use App\Models\ExternalSession;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\InteractsWithPortal;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\PizzasysMock;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `GET /api/v1/auth/me`, `GET /api/v1/auth/tokens`, `DELETE /api/v1/auth/tokens/{id}` and `POST /api/v1/auth/logout`: what a mobile client
 * needs to know about, and to manage, its own bearer token. Everything is scoped to the caller (another user's token is a 404), a token
 * string is never returned, and in mode 2 revoking a token also ends the portal session behind it.
 */
class StaffTokensApiTest extends TestCase
{
    use InteractsWithPortal, InteractsWithRealtime, RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    /** @return array{0: User, 1: string, 2: int} */
    private function signedIn(string $device = 'iPhone 17', ?User $user = null): array
    {
        $user ??= User::factory()->agent()->create();
        $token = $user->createToken($device, ['staff']);

        return [$user, $token->plainTextToken, (int) $token->accessToken->getKey()];
    }

    // ---- me --------------------------------------------------------------------------------------------------------------------

    public function test_me_describes_the_user_the_driver_and_the_token_it_was_called_with(): void
    {
        [$user, $token, $tokenId] = $this->signedIn('Pixel 9');

        $json = $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk()->json('data');

        $this->assertSame($user->id, $json['user']['id']);
        $this->assertSame($user->email, $json['user']['email']);
        $this->assertTrue($json['user']['is_agent']);
        $this->assertFalse($json['user']['is_admin']);
        $this->assertSame('fortify', $json['mode']);
        $this->assertTrue($json['capabilities']['profileEditable']);
        $this->assertSame($tokenId, $json['token']['id']);
        $this->assertSame('Pixel 9', $json['token']['name']);
        $this->assertSame(['staff'], $json['token']['abilities']);
        $this->assertTrue($json['token']['current']);
        $this->assertEqualsWithDelta(now()->timestamp, strtotime($json['serverTime']), 5, 'the server clock, for clock-skew correction');
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $json['serverTime']);
    }

    public function test_me_gives_a_native_client_the_public_realtime_address_and_never_the_secret(): void
    {
        [, $token] = $this->signedIn();

        $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk()->assertJsonPath('data.realtime', null);

        $this->useReverbBroadcaster();
        config(['reverb.apps.apps.0.options.host' => 'chat.example.com', 'reverb.apps.apps.0.options.port' => 443, 'reverb.apps.apps.0.options.scheme' => 'https']);
        $this->app['auth']->forgetGuards();

        $response = $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk();

        $this->assertSame(['key' => self::REVERB_KEY, 'host' => 'chat.example.com', 'port' => 443, 'scheme' => 'https'], $response->json('data.realtime'));
        $this->assertStringNotContainsString(self::REVERB_SECRET, (string) $response->getContent());
    }

    public function test_me_has_no_token_for_the_dashboard_session_cookie(): void
    {
        $user = User::factory()->agent()->create();

        $json = $this->actingAs($user)->getJson('/api/v1/auth/me')->assertOk()->json('data');

        $this->assertSame($user->id, $json['user']['id']);
        $this->assertNull($json['token']);
    }

    public function test_me_never_carries_secrets_or_permission_lists(): void
    {
        [, $token] = $this->signedIn();

        $body = (string) $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk()->getContent();

        foreach (['password', 'two_factor', 'remember_token', 'external_id', 'permissions'] as $secret) {
            $this->assertStringNotContainsString($secret, $body);
        }

        $this->assertStringNotContainsString(explode('|', $token)[1], $body, 'the token secret is never echoed back');
    }

    public function test_the_whole_group_needs_a_credential_a_chat_role_and_an_active_account(): void
    {
        foreach (['/api/v1/auth/me', '/api/v1/auth/tokens'] as $uri) {
            $this->getJson($uri)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        }

        $this->postJson('/api/v1/auth/logout')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->deleteJson('/api/v1/auth/tokens/1')->assertUnauthorized();

        [, $noRole] = $this->signedIn(user: User::factory()->withoutChatAccess()->create());
        $this->withToken($noRole)->getJson('/api/v1/auth/me')->assertForbidden()->assertJsonPath('error.code', 'no_chat_access');

        // The test kernel keeps the resolved guard user for the whole test: every request below starts from scratch, like a new process.
        $this->app['auth']->forgetGuards();
        [$inactive, $token] = $this->signedIn();
        $inactive->forceFill(['is_active' => false])->save();
        $this->assertSame(0, PersonalAccessToken::query()->where('tokenable_id', $inactive->id)->count(), 'deactivating deletes the tokens');
        $this->withToken($token)->getJson('/api/v1/auth/me')->assertUnauthorized();
    }

    public function test_a_token_past_its_lifetime_is_refused_and_me_reports_when_it_ends(): void
    {
        config(['sanctum.expiration' => 60]);
        [, $token] = $this->signedIn();

        $expiresAt = $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk()->json('data.token.expiresAt');
        $this->assertEqualsWithDelta(now()->addMinutes(60)->timestamp, strtotime($expiresAt), 5);

        $this->travel(61)->minutes();
        // Sanctum keeps the guard's resolved user across requests of one test; a new request must start from scratch.
        $this->app['auth']->forgetGuards();

        $this->withToken($token)->getJson('/api/v1/auth/me')->assertUnauthorized();
    }

    // ---- list ------------------------------------------------------------------------------------------------------------------

    public function test_the_list_holds_only_my_own_tokens_newest_first_and_marks_the_current_one(): void
    {
        [$user, $first] = $this->signedIn('Old phone');
        $this->travel(5)->minutes();
        [, $second, $secondId] = $this->signedIn('New phone', $user);
        $this->signedIn('Someone else\'s phone');

        $rows = $this->withToken($second)->getJson('/api/v1/auth/tokens')->assertOk()->assertJsonPath('meta.next_cursor', null)->json('data');

        $this->assertSame(['New phone', 'Old phone'], array_column($rows, 'name'));
        $this->assertSame([true, false], array_column($rows, 'current'));
        $this->assertSame($secondId, $rows[0]['id']);
        $this->assertSame(['staff'], $rows[0]['abilities']);
        $this->assertNotNull($rows[0]['expiresAt']);
        $this->assertNotNull($rows[0]['createdAt']);

        $body = (string) $this->withToken($first)->getJson('/api/v1/auth/tokens')->getContent();
        $this->assertStringNotContainsString(explode('|', $first)[1], $body);
        $this->assertStringNotContainsString(hash('sha256', explode('|', $first)[1]), $body, 'not even the stored hash is returned');
        $this->assertStringNotContainsString('"token"', $body);
    }

    public function test_last_used_at_follows_the_calls_made_with_the_token(): void
    {
        [, $token] = $this->signedIn();

        $this->travel(2)->minutes();
        $this->withToken($token)->getJson('/api/v1/auth/me')->assertOk();

        $row = $this->withToken($token)->getJson('/api/v1/auth/tokens')->json('data.0');
        $this->assertEqualsWithDelta(now()->timestamp, strtotime((string) $row['lastUsedAt']), 5);
    }

    // ---- revoke one ------------------------------------------------------------------------------------------------------------

    public function test_a_user_revokes_one_of_their_other_devices(): void
    {
        [$user, $phone] = $this->signedIn('Phone');
        [, $tablet, $tabletId] = $this->signedIn('Tablet', $user);

        $this->withToken($phone)->deleteJson('/api/v1/auth/tokens/'.$tabletId)->assertNoContent();

        $this->assertNull(PersonalAccessToken::find($tabletId));
        $this->app['auth']->forgetGuards();
        $this->withToken($tablet)->getJson('/api/v1/auth/me')->assertUnauthorized();
        $this->app['auth']->forgetGuards();
        $this->withToken($phone)->getJson('/api/v1/auth/me')->assertOk();
    }

    public function test_nobody_can_revoke_or_find_another_users_token(): void
    {
        [, $mine] = $this->signedIn('Mine');
        [$other, , $otherId] = $this->signedIn('Theirs');

        $this->withToken($mine)->deleteJson('/api/v1/auth/tokens/'.$otherId)
            ->assertNotFound()
            ->assertJsonPath('error.code', 'token_not_found');

        $this->assertNotNull(PersonalAccessToken::find($otherId), 'the other user\'s token is untouched');
        $this->assertSame(1, $other->tokens()->count());

        $this->withToken($mine)->deleteJson('/api/v1/auth/tokens/999999')->assertNotFound()->assertJsonPath('error.code', 'token_not_found');
        $this->withToken($mine)->deleteJson('/api/v1/auth/tokens/not-a-number')->assertNotFound();
    }

    public function test_an_administrator_cannot_revoke_a_staff_members_token_through_this_endpoint(): void
    {
        [, , $agentTokenId] = $this->signedIn('Agent phone');
        [, $admin] = $this->signedIn('Admin phone', User::factory()->admin()->create());

        $this->withToken($admin)->deleteJson('/api/v1/auth/tokens/'.$agentTokenId)->assertNotFound();

        $this->assertNotNull(PersonalAccessToken::find($agentTokenId), 'own tokens only, whoever asks');
    }

    // ---- logout ----------------------------------------------------------------------------------------------------------------

    public function test_logout_revokes_only_the_token_it_was_made_with(): void
    {
        [$user, $phone, $phoneId] = $this->signedIn('Phone');
        [, $tablet, $tabletId] = $this->signedIn('Tablet', $user);

        $this->withToken($phone)->postJson('/api/v1/auth/logout')->assertNoContent();

        $this->assertNull(PersonalAccessToken::find($phoneId));
        $this->assertNotNull(PersonalAccessToken::find($tabletId), 'the other device keeps its token');

        $this->app['auth']->forgetGuards();
        $this->withToken($phone)->getJson('/api/v1/auth/me')->assertUnauthorized();
        $this->app['auth']->forgetGuards();
        $this->withToken($tablet)->getJson('/api/v1/auth/me')->assertOk();
    }

    public function test_logout_with_the_dashboard_cookie_is_refused_and_signs_nobody_out(): void
    {
        [$user, , $tokenId] = $this->signedIn();

        $this->actingAs($user)->postJson('/api/v1/auth/logout')
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'not_a_token_session');

        $this->assertNotNull(PersonalAccessToken::find($tokenId));
    }

    // ---- mode 2 ----------------------------------------------------------------------------------------------------------------

    public function test_in_external_auth_mode_logout_ends_the_portal_session_and_logs_the_portal_token_out(): void
    {
        $this->usePortalMode();
        $portal = PizzasysMock::make()->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')->fake();

        $phone = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'iPhone 17');
        $laptop = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'laptop');
        $this->assertSame(2, ExternalSession::query()->whereNull('revoked_at')->count());

        $me = $this->withToken((string) $phone->token)->getJson('/api/v1/auth/me')->assertOk()->json('data');
        $this->assertSame('pizzasys', $me['mode']);
        $this->assertSame('pizzasys', $me['user']['auth_source']);
        $this->assertSame('iPhone 17', $me['token']['name']);

        $this->withToken((string) $phone->token)->postJson('/api/v1/auth/logout')->assertNoContent();

        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count(), 'the other device keeps its session');
        $this->assertSame('logout', ExternalSession::query()->whereNotNull('revoked_at')->sole()->revoked_reason);
        $this->assertSame(1, $portal->calls('logout'), 'the portal token behind the phone was logged out upstream');
        Http::assertSent(fn ($request): bool => str_ends_with($request->url(), '/auth/logout'));
        $this->assertSame(1, PersonalAccessToken::query()->count());

        $this->app['auth']->forgetGuards();
        $this->withToken((string) $laptop->token)->getJson('/api/v1/auth/me')->assertOk();
    }

    public function test_in_external_auth_mode_revoking_another_device_ends_its_portal_session_too(): void
    {
        $this->usePortalMode();
        $portal = PizzasysMock::make()->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')->fake();

        $phone = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'iPhone 17');
        $laptop = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'laptop');
        $laptopTokenId = (int) PersonalAccessToken::findToken((string) $laptop->token)?->getKey();

        $this->withToken((string) $phone->token)->deleteJson('/api/v1/auth/tokens/'.$laptopTokenId)->assertNoContent();

        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
        $this->assertSame(1, $portal->calls('logout'));
        $this->assertNull(PersonalAccessToken::find($laptopTokenId));
    }

    public function test_the_portal_environment_row_is_untouched_by_token_management(): void
    {
        $environment = $this->usePortalMode();
        PizzasysMock::make()->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')->fake();
        $result = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'phone');

        $this->withToken((string) $result->token)->getJson('/api/v1/auth/tokens')->assertOk()->assertJsonCount(1, 'data');

        $this->assertSame(1, AuthEnvironment::query()->count());
        $this->assertTrue($environment->is(AuthEnvironment::query()->sole()));
    }
}
