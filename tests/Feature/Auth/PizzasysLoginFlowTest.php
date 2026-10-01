<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\ExternalSession;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use Inertia\Testing\AssertableInertia as Assert;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Support\InteractsWithPortal;
use Tests\Support\PizzasysMock;
use Tests\TestCase;

/**
 * Mode 2 through the real HTTP stack: the login form posts to OUR backend, Fortify logs the user in, the Login event
 * opens the portal session and every later request is revalidated by `session.valid`.
 */
class PizzasysLoginFlowTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    private PizzasysMock $portal;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->usePortalMode();
        $this->portal = PizzasysMock::make()
            ->user('agent@test.local', 'agent-pass', 'agent', 'Test Agent')
            ->user('admin@test.local', 'admin-pass', 'admin', 'Test Admin')
            ->user('norole@test.local', 'norole-pass', 'norole', 'No Role')
            ->fake();

        // A route group the way the management API is protected (docs/contracts/auth-driver.md).
        Route::middleware(['api', 'auth:sanctum', 'session.valid', 'chat.access'])->get('/api/v1/_probe', fn () => ['ok' => true]);
    }

    /** The dashboard calls the management API with its session cookie from a stateful origin. */
    private function fromDashboard(): static
    {
        return $this->withHeaders(['Referer' => 'http://localhost/dashboard']);
    }

    private function signIn(string $email = 'agent@test.local', string $password = 'agent-pass')
    {
        return $this->post(route('login.store'), ['email' => $email, 'password' => $password]);
    }

    public function test_the_login_page_in_mode_two_has_no_register_or_reset_links(): void
    {
        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page
            ->component('auth/login')
            ->where('canRegister', false)
            ->where('canResetPassword', false)
            ->where('auth.mode', 'pizzasys')
            ->where('auth.capabilities.portalUrl', PizzasysMock::BASE_URL));
    }

    public function test_an_agent_signs_in_through_the_portal_and_lands_on_the_dashboard(): void
    {
        $this->signIn()->assertRedirect(route('dashboard', absolute: false));

        $user = User::query()->where('email', 'agent@test.local')->sole();
        $this->assertAuthenticatedAs($user);

        $session = ExternalSession::query()->sole();
        $this->assertSame($user->id, $session->user_id);
        $this->assertSame($this->portal->tokenFor('agent@test.local'), $session->token);
        $this->assertSame($session->id, session('auth.external_session'), 'the browser session carries the portal session id');
        $this->assertNotNull($session->laravel_session_id);
        $this->assertSame('127.0.0.1', $session->ip);

        $this->get(route('dashboard'))->assertOk();
    }

    public function test_shared_props_never_leak_portal_internals(): void
    {
        $this->signIn();

        $response = $this->get(route('dashboard'));
        $response->assertInertia(fn (Assert $page) => $page
            ->where('auth.mode', 'pizzasys')
            ->where('auth.user.auth_source', 'pizzasys')
            ->where('auth.user.is_agent', true)
            ->where('auth.user.is_admin', false)
            ->where('auth.capabilities', ['canRegister' => false, 'canResetPassword' => false, 'canManage2fa' => false, 'profileEditable' => false, 'portalUrl' => PizzasysMock::BASE_URL]));

        $json = (string) json_encode($response->inertiaProps());
        foreach ([$this->portal->tokenFor('agent@test.local'), PizzasysMock::SERVICE_TOKEN, 'external_id', 'chat.agent', 'permissions'] as $secret) {
            $this->assertStringNotContainsString($secret, $json);
        }
    }

    public function test_wrong_credentials_show_the_generic_error(): void
    {
        $this->signIn('agent@test.local', 'nope')->assertSessionHasErrors(['email' => trans('auth.failed')]);

        $this->assertGuest();
        $this->assertSame(0, ExternalSession::query()->count());
    }

    public function test_an_unreachable_portal_is_reported_as_such(): void
    {
        $this->portal->outage('connection');

        $this->signIn()->assertSessionHasErrors('email')->assertSessionHas('reason', 'unavailable');

        $this->assertStringContainsString('Auth Portal unreachable', session('errors')->first('email'));
        $this->assertGuest();
    }

    public function test_the_login_page_receives_the_unavailable_reason_after_a_portal_outage(): void
    {
        $this->portal->outage('timeout');

        $this->followingRedirects()->from(route('login'))->post(route('login.store'), ['email' => 'agent@test.local', 'password' => 'agent-pass'])
            ->assertInertia(fn (Assert $page) => $page
                ->component('auth/login')
                ->where('reason', 'unavailable')
                ->where('errors.email', fn ($message) => str_contains((string) $message, 'Auth Portal unreachable')));
    }

    public function test_a_user_without_chat_access_is_turned_away_with_the_no_access_notice(): void
    {
        $this->signIn('norole@test.local', 'norole-pass')
            ->assertSessionHasErrors('email')
            ->assertSessionHas('reason', 'no_chat_access');

        $this->assertStringContainsString('no access', session('errors')->first('email'));
        $this->assertGuest();
        $this->assertSame(0, User::query()->count());
    }

    public function test_remember_me_never_applies_to_portal_sessions(): void
    {
        $response = $this->post(route('login.store'), ['email' => 'agent@test.local', 'password' => 'agent-pass', 'remember' => 'on']);

        $response->assertRedirect(route('dashboard', absolute: false));
        $this->assertNull(collect($response->headers->getCookies())->first(fn ($cookie) => str_starts_with($cookie->getName(), 'remember_web_')));
    }

    public function test_logging_out_revokes_the_session_and_closes_only_that_upstream_token(): void
    {
        $this->signIn();
        $first = $this->portal->tokenFor('agent@test.local');
        $second = $this->portal->reissueToken('agent@test.local'); // the same person is signed in elsewhere too

        $this->post(route('logout'))->assertRedirect('/');

        $this->assertGuest();
        $session = ExternalSession::query()->sole();
        $this->assertNotNull($session->revoked_at);
        $this->assertSame('logout', $session->revoked_reason);
        $this->assertNull($session->token);

        $this->assertSame(1, $this->portal->calls('logout'));
        Http::assertSent(fn ($request): bool => str_ends_with($request->url(), '/auth/logout') && $request->hasHeader('Authorization', 'Bearer '.$first));
        Http::assertNotSent(fn ($request): bool => str_ends_with($request->url(), '/auth/logout') && $request->hasHeader('Authorization', 'Bearer '.$second));
    }

    public function test_a_session_revoked_upstream_is_signed_out_on_the_next_request_after_the_cache_expires(): void
    {
        $this->signIn();
        $this->portal->revoke('agent@test.local');

        $this->get(route('dashboard'))->assertOk(); // still inside the verify TTL: revocation lag is bounded by it

        $this->travel(2)->minutes();

        $this->get(route('dashboard'))->assertRedirect(route('login'));
        $this->assertGuest();
        $this->assertSame('upstream_inactive', ExternalSession::query()->sole()->revoked_reason);
    }

    public function test_api_clients_get_401_json_for_a_revoked_session(): void
    {
        $this->signIn();
        $this->portal->revoke('agent@test.local');
        $this->travel(2)->minutes();

        $this->fromDashboard()->getJson('/api/v1/_probe')->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_a_portal_outage_within_the_grace_window_changes_nothing_for_the_user(): void
    {
        $this->signIn();
        $this->portal->outage('timeout');
        $this->travel(5)->minutes();

        $this->get(route('dashboard'))->assertOk();
        $this->fromDashboard()->getJson('/api/v1/_probe')->assertOk();
        $this->assertAuthenticated();
    }

    public function test_beyond_the_grace_window_requests_get_503_but_the_session_is_kept(): void
    {
        $this->signIn();
        $this->portal->outage('connection');
        $this->travel(31)->minutes();

        $this->fromDashboard()->getJson('/api/v1/_probe')
            ->assertStatus(503)
            ->assertJsonPath('error.code', 'auth_unavailable')
            ->assertHeader('Retry-After');

        $this->get(route('dashboard'))->assertStatus(503)->assertSee('still signed in');

        $this->assertAuthenticated();
        $this->assertNull(ExternalSession::query()->sole()->revoked_at);

        // and it simply works again once the portal is back
        $this->portal->recover();
        $this->get(route('dashboard'))->assertOk();
    }

    public function test_signing_out_still_works_while_the_portal_is_down_beyond_the_grace_window(): void
    {
        $this->signIn();
        $this->portal->outage('connection');
        $this->travel(31)->minutes();

        $this->post(route('logout'))->assertRedirect('/');

        $this->assertGuest();
        $this->assertNotNull(ExternalSession::query()->sole()->revoked_at);
    }

    public function test_the_verdict_is_computed_once_per_request_even_with_the_alias_on_top_of_the_web_group(): void
    {
        $this->signIn();
        $this->travel(2)->minutes();
        $verifies = $this->portal->calls('token-verify');

        $this->fromDashboard()->getJson('/api/v1/_probe')->assertOk();

        $this->assertSame($verifies + 1, $this->portal->calls('token-verify'));
    }

    public function test_features_the_portal_owns_are_not_reachable(): void
    {
        $this->get(route('register'))->assertNotFound();
        $this->get(route('password.request'))->assertNotFound();

        $this->signIn();

        $this->get(route('security.edit'))->assertNotFound();
        $this->patch(route('profile.update'), ['name' => 'Mallory', 'email' => 'mallory@example.test'])->assertNotFound();
        $this->put(route('user-password.update'), ['current_password' => 'x', 'password' => 'new-password-1', 'password_confirmation' => 'new-password-1'])->assertNotFound();
        $this->delete(route('profile.destroy'), ['password' => 'x'])->assertNotFound();
        $this->assertSame('Test Agent', User::query()->where('email', 'agent@test.local')->value('name'));
    }

    public function test_a_second_login_of_the_same_person_creates_a_second_session_and_one_user(): void
    {
        $this->signIn();
        $this->post(route('logout'));
        $this->signIn();

        $this->assertSame(1, User::query()->count());
        $this->assertSame(2, ExternalSession::query()->count());
        $this->assertSame(1, ExternalSession::query()->whereNull('revoked_at')->count());
    }

    public function test_a_bearer_token_from_the_api_login_is_validated_against_the_portal_too(): void
    {
        $result = app(AuthDriver::class)->attemptForApi(['email' => 'agent@test.local', 'password' => 'agent-pass'], 'phone');
        $this->assertTrue($result->isOk());

        $this->withToken((string) $result->token)->getJson('/api/v1/_probe')->assertOk();

        $this->portal->revoke('agent@test.local');
        $this->travel(2)->minutes();
        $this->app['auth']->forgetGuards();

        $this->withToken((string) $result->token)->getJson('/api/v1/_probe')->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
        $this->assertSame(0, PersonalAccessToken::query()->count(), 'our token dies with the portal session');
    }

    public function test_a_local_account_cannot_use_the_app_in_portal_mode(): void
    {
        $local = User::factory()->agent()->create(['auth_source' => 'local']);

        $this->actingAs($local)->get(route('dashboard'))->assertRedirect(route('login'));
    }
}
