<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Sessions of the dashboard: background requests do not write them, one page request keeps them alive.
 *
 * Background requests of the dashboard (`api/*`, `POST /broadcasting/auth`) must not write the session: with the file driver the last
 * writer wins, so a poll that was already running when a page request stored something (the URL a password confirmation returns to, a
 * flash message, the "session ended" notice) wrote the old payload back over it, aged the flash away and re-sent a session cookie.
 *
 * The real file driver, real cookies: every request below carries the session cookie of the previous response, like a browser.
 */
class ManagementApiSessionTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private string $directory;

    private string $sessionId = '';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->directory = sys_get_temp_dir().'/chat-session-test-'.Str::random(12);
        File::ensureDirectoryExists($this->directory);
        config(['session.driver' => 'file', 'session.files' => $this->directory]);
        $this->app['session']->forgetDrivers();
        $this->app->instance('session.store', $this->app['session']->driver());

        // What a page request stores for the next one, and what the next page request reads.
        Route::middleware('web')->get('/_probe/store', function () {
            session()->flash('probe', 'flashed');
            session()->put('url.intended', 'http://localhost/settings/security');

            return 'stored';
        });
        Route::middleware('web')->get('/_probe/read', fn () => response()->json([
            'flash' => session('probe'),
            'intended' => session('url.intended'),
        ]));
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->directory);

        parent::tearDown();
    }

    /** The stateful headers of the dashboard SPA (Sanctum treats Referer / Origin of a stateful host as "from the frontend"). */
    private function dashboardHeaders(): array
    {
        return ['Referer' => config('app.url'), 'Origin' => config('app.url'), 'X-Requested-With' => 'XMLHttpRequest'];
    }

    private function sessionCookie(TestResponse $response): ?string
    {
        return $response->getCookie((string) config('session.cookie'), true, false)?->getValue();
    }

    /**
     * One browser request: the session cookie of the last response that set one goes along. Every request starts with an empty
     * session store and no resolved user, like a new PHP process would (the test kernel keeps both for the whole test, which would
     * hide exactly what is being tested: a request must find its session in the file, not in memory).
     *
     * @param  array<string, mixed>  $data
     * @param  array<string, string>  $headers
     */
    private function browse(string $method, string $uri, array $data = [], array $headers = []): TestResponse
    {
        $this->app['session']->driver()->flush();
        $this->app['auth']->forgetGuards();

        $request = $this->withHeaders($headers)->withCredentials();

        if ($this->sessionId !== '') {
            $request = $request->withCookie((string) config('session.cookie'), $this->sessionId);
        }

        $response = $headers !== []
            ? $request->json($method, $uri, $data)
            : ($method === 'GET' ? $request->get($uri) : $request->post($uri, $data));
        $cookie = $this->sessionCookie($response);

        if ($cookie !== null) {
            $this->sessionId = $cookie;
        }

        return $response;
    }

    private function signIn(User $user): void
    {
        $this->browse('POST', route('login.store', absolute: false), ['email' => $user->email, 'password' => 'password'])->assertRedirect();
        $this->assertNotSame('', $this->sessionId);
    }

    /** @return array{flash: ?string, intended: ?string} */
    private function read(): array
    {
        return $this->browse('GET', '/_probe/read')->assertOk()->json();
    }

    private function sessionFile(): string
    {
        return $this->directory.'/'.$this->sessionId;
    }

    public function test_management_api_requests_leave_the_flash_and_the_intended_url_alone(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $this->browse('GET', '/_probe/store')->assertOk();

        // A burst of what the dashboard does in the background right after a page load (and a write, and the socket's authorisation).
        $this->browse('GET', '/api/v1/me/presence', headers: $this->dashboardHeaders())->assertOk();
        $this->browse('GET', '/api/v1/conversations/queue', headers: $this->dashboardHeaders())->assertOk();
        $this->browse('GET', '/api/v1/conversations?status=active&type=live&limit=100', headers: $this->dashboardHeaders())->assertOk();
        $this->browse('POST', '/api/v1/me/presence/heartbeat', headers: $this->dashboardHeaders());
        $this->browse('POST', '/broadcasting/auth', ['channel_name' => 'private-staff.1', 'socket_id' => '1.2'], $this->dashboardHeaders());

        // The next PAGE request still sees what the earlier page request stored (the flash lasts for exactly that request).
        $this->assertSame(['flash' => 'flashed', 'intended' => 'http://localhost/settings/security'], $this->read());
        // ... and after that one the flash is gone, as always.
        $this->assertSame(['flash' => null, 'intended' => 'http://localhost/settings/security'], $this->read());
    }

    public function test_management_api_responses_carry_no_cookie_at_all(): void
    {
        $this->signIn(User::factory()->agent()->create());

        foreach (['GET /api/v1/me/presence', 'POST /api/v1/me/presence/heartbeat'] as $call) {
            [$method, $uri] = explode(' ', $call);
            $response = $this->browse($method, $uri, headers: $this->dashboardHeaders());

            $this->assertSame([], $response->headers->getCookies(), "{$call} must not set a cookie");
        }
    }

    public function test_management_api_requests_never_write_the_session_file(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $content = file_get_contents($this->sessionFile());
        // An hour in the past: a rewrite (a "touch" of the lifetime) would move it.
        $past = time() - 3600;
        touch($this->sessionFile(), $past);
        clearstatcache();

        $this->browse('GET', '/api/v1/me/presence', headers: $this->dashboardHeaders())->assertOk();
        $this->browse('POST', '/api/v1/me/presence/heartbeat', headers: $this->dashboardHeaders());

        clearstatcache();
        $this->assertSame($content, file_get_contents($this->sessionFile()));
        $this->assertSame($past, filemtime($this->sessionFile()), 'the session file was rewritten');
    }

    public function test_an_unknown_session_cookie_on_the_api_creates_no_session(): void
    {
        $this->sessionId = Str::random(40);

        $response = $this->browse('GET', '/api/v1/me/presence', headers: $this->dashboardHeaders());

        $response->assertUnauthorized();
        $this->assertSame([], $response->headers->getCookies());
        $this->assertSame([], File::files($this->directory), 'a stale cookie must not bring a session file back to life');
    }

    public function test_api_requests_still_load_the_session_to_authenticate_and_to_check_csrf(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $this->browse('GET', '/api/v1/me/presence', headers: $this->dashboardHeaders())
            ->assertOk()
            ->assertJsonPath('data.status', 'offline');
    }

    public function test_page_requests_still_write_the_session_age_the_flash_and_set_the_cookie(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $this->browse('GET', '/_probe/store')->assertOk();

        $response = $this->browse('GET', '/_probe/read')->assertOk();

        $this->assertNotSame([], $response->headers->getCookies(), 'page responses keep setting the session cookie');
        $this->assertSame('flashed', $response->json('flash'));
        $this->assertNull($this->read()['flash']);
    }

    public function test_a_session_that_the_api_found_revoked_is_ended_by_the_next_page_request_with_its_notice(): void
    {
        $agent = User::factory()->agent()->create();

        $this->signIn($agent);
        $agent->forceFill(['is_active' => false])->saveQuietly();
        $this->app['auth']->forgetGuards();

        // A background request finds the session revoked first: it is turned away ...
        $this->browse('GET', '/api/v1/me/presence', headers: $this->dashboardHeaders())
            ->assertUnauthorized()
            ->assertJsonPath('error.code', 'session_revoked');
        $this->app['auth']->forgetGuards();

        // ... and the navigation that follows is the one that ends the session and carries the notice to the sign-in page.
        $this->browse('GET', '/dashboard')->assertRedirect(route('login'));
        $this->browse('GET', '/login')->assertInertia(fn ($page) => $page
            ->where('reason', 'session_revoked')
            ->where('flash.error', 'Your session has ended. Please sign in again.'));
        // The account is signed out for good: the old cookie opens nothing any more.
        $this->browse('GET', '/dashboard')->assertRedirect(route('login'));
    }

    /** @return array<string, string> The headers of the dashboard's keep-alive call (the shared API client sends both). */
    private function keepAliveHeaders(): array
    {
        return ['X-Requested-With' => 'XMLHttpRequest', 'Accept' => 'application/json'];
    }

    public function test_the_keepalive_saves_the_session_so_that_its_lifetime_is_extended(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $past = time() - 3600;
        touch($this->sessionFile(), $past);
        clearstatcache();

        $response = $this->browse('GET', '/session/keepalive', headers: $this->keepAliveHeaders());

        $response->assertNoContent();
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        clearstatcache();
        $this->assertGreaterThan($past + 3000, filemtime($this->sessionFile()), 'the keep-alive must rewrite the session file');
        $this->assertNotNull($this->sessionCookie($response), 'and extend the cookie like any page');
    }

    public function test_the_keepalive_is_not_the_next_page_request(): void
    {
        $this->signIn(User::factory()->agent()->create());
        $this->browse('GET', '/_probe/store')->assertOk();

        $this->browse('GET', '/session/keepalive', headers: $this->keepAliveHeaders())->assertNoContent();
        // Not even without the ajax header: it never becomes the page that "back" goes to.
        $this->browse('GET', '/session/keepalive')->assertNoContent();

        $stored = json_decode((string) file_get_contents($this->sessionFile()), true);
        $this->assertStringEndsWith('/_probe/store', $stored['_previous']['url']);
        $this->assertSame(['flash' => 'flashed', 'intended' => 'http://localhost/settings/security'], $this->read());
    }

    public function test_the_keepalive_is_for_signed_in_staff_only(): void
    {
        $this->browse('GET', '/session/keepalive', headers: $this->keepAliveHeaders())
            ->assertUnauthorized();
    }

    public function test_the_keepalive_turns_away_an_account_that_lost_its_access(): void
    {
        $agent = User::factory()->agent()->create();
        $this->signIn($agent);

        $agent->forceFill(['is_agent' => false, 'is_admin' => false])->saveQuietly();
        $this->browse('GET', '/session/keepalive', headers: $this->keepAliveHeaders())
            ->assertForbidden()
            ->assertJsonPath('error.code', 'no_chat_access');
    }

    public function test_the_keepalive_turns_away_a_revoked_session(): void
    {
        $agent = User::factory()->agent()->create();
        $this->signIn($agent);

        $agent->forceFill(['is_active' => false])->saveQuietly();
        $this->browse('GET', '/session/keepalive', headers: $this->keepAliveHeaders())
            ->assertUnauthorized()
            ->assertJsonPath('error.code', 'session_revoked');
    }
}
