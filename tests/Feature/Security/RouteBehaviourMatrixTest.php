<?php

namespace Tests\Feature\Security;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\DeviceToken;
use App\Models\Message;
use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Route as LaravelRoute;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * What the classes of `RouteClassificationTest` DO, route by route: who is turned away, which cookie request needs a CSRF token, who gets
 * CORS headers, and the BOLA sweep (a second user / visitor against every id-addressed route). Walks the real route table, so a route
 * added tomorrow is exercised without touching this file (except the BOLA table, which a rot guard keeps complete).
 */
class RouteBehaviourMatrixTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private const ULID = '01HZZZZZZZZZZZZZZZZZZZZZZZ';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------------------

    /**
     * @return list<array{method: string, uri: string, route: LaravelRoute}> one entry per verb of every route under the prefix
     */
    private function routes(string $prefix, ?callable $filter = null): array
    {
        $found = [];

        foreach (Route::getRoutes() as $route) {
            if (! str_starts_with($route->uri(), $prefix) || ($filter !== null && ! $filter($route))) {
                continue;
            }

            foreach ($route->methods() as $method) {
                if (! in_array($method, ['HEAD', 'OPTIONS'], true)) {
                    $found[] = ['method' => $method, 'uri' => $this->concrete($route), 'route' => $route];
                }
            }
        }

        return $found;
    }

    private function management(LaravelRoute $route): bool
    {
        return str_starts_with($route->uri(), 'api/v1/') && ! str_starts_with($route->uri(), 'api/v1/public/') && ! $this->guestRoute($route);
    }

    /** The native sign-in (7D): unauthenticated on purpose, covered by StaffSignInTest. */
    private function guestRoute(LaravelRoute $route): bool
    {
        foreach ($route->methods() as $method) {
            if (array_key_exists($method.' '.$route->uri(), RouteClassificationTest::API_GUEST)) {
                return true;
            }
        }

        return false;
    }

    private function adminOnly(LaravelRoute $route): bool
    {
        $names = array_map(fn ($middleware): string => is_string($middleware) ? (string) preg_replace('/^.*\\\\/', '', $middleware) : '', app('router')->gatherRouteMiddleware($route));

        return in_array('EnsureAdmin', $names, true) || in_array('EnsureWhatsAppAdmin', $names, true);
    }

    /** The URI with every placeholder replaced by a value that satisfies the route's own constraint. */
    private function concrete(LaravelRoute $route, array $with = []): string
    {
        $uri = '/'.$route->uri();

        foreach ($route->parameterNames() as $name) {
            $value = $with[$name] ?? match (true) {
                $name === 'key' => 'wk_aaaaaaaaaaaaaaaa',
                isset($route->wheres[$name]) && str_contains($route->wheres[$name], '0-7') => self::ULID,
                default => '1',
            };
            $uri = str_replace('{'.$name.'}', (string) $value, $uri);
        }

        return $uri;
    }

    /**
     * @param  array<string, mixed>  $body
     * @param  array<string, string>  $headers
     */
    private function send(string $method, string $uri, array $body = [], array $headers = []): TestResponse
    {
        return $this->withHeaders($headers)->json($method, $uri, $body);
    }

    // ---- who is turned away -----------------------------------------------------------------------------------------------------------

    public function test_every_management_route_turns_away_a_guest_an_account_without_a_chat_role_and_a_deactivated_account(): void
    {
        $roleless = User::factory()->withoutChatAccess()->create();
        $inactive = User::factory()->agent()->inactive()->create();
        $count = 0;

        foreach ($this->routes('api/v1/', fn (LaravelRoute $route): bool => $this->management($route)) as $entry) {
            $count++;
            $label = $entry['method'].' '.$entry['uri'];

            $this->app['auth']->forgetGuards();
            $this->send($entry['method'], $entry['uri'])->assertStatus(401);
            $this->assertSame('unauthenticated', $this->send($entry['method'], $entry['uri'])->json('error.code'), $label);

            // (An id that does not exist is a 404 for such a caller: model binding runs before the role checks. The classification test pins
            // that every one of these routes carries session.valid and chat.access.)
            $hasId = $entry['route']->parameterNames() !== [];

            $this->app['auth']->forgetGuards();
            $forbidden = $this->actingAs($roleless, 'sanctum')->json($entry['method'], $entry['uri']);
            $this->assertContains($forbidden->getStatusCode(), $hasId ? [403, 404] : [403], $label.' must turn an account without a chat role away');

            $this->app['auth']->forgetGuards();
            $response = $this->actingAs($inactive, 'sanctum')->json($entry['method'], $entry['uri']);
            $this->assertContains($response->getStatusCode(), $hasId ? [401, 404] : [401], $label.' must turn a deactivated account away');

            if ($response->getStatusCode() === 401) {
                $this->assertSame('session_revoked', $response->json('error.code'), $label);
            }
        }

        $this->assertGreaterThan(60, $count);
    }

    public function test_an_agent_is_refused_on_every_admin_only_route_and_an_administrator_is_not(): void
    {
        $agent = User::factory()->agent()->create();
        $admin = User::factory()->admin()->create();
        $checked = 0;

        foreach ($this->routes('api/v1/', fn (LaravelRoute $route): bool => $this->management($route) && $this->adminOnly($route)) as $entry) {
            $checked++;

            $this->app['auth']->forgetGuards();
            $refused = $this->actingAs($agent, 'sanctum')->json($entry['method'], $entry['uri']);
            // Model binding runs before the role checks (middleware priority), so an id that does not exist is a 404 even for an agent;
            // an existing object, and every route without an id, is the 403 (docs/security.md, "Known limits").
            $this->assertContains($refused->getStatusCode(), $entry['route']->parameterNames() === [] ? [403] : [403, 404], $entry['method'].' '.$entry['uri'].' must be admin-only');

            if ($refused->getStatusCode() === 403) {
                $this->assertSame('forbidden', $refused->json('error.code'), $entry['method'].' '.$entry['uri']);
            }

            $this->app['auth']->forgetGuards();
            $answer = $this->actingAs($admin, 'sanctum')->json($entry['method'], $entry['uri']);
            $this->assertNotSame(403, $answer->getStatusCode(), $entry['method'].' '.$entry['uri'].': an administrator is not turned away');
            $this->assertNotSame(401, $answer->getStatusCode(), $entry['method'].' '.$entry['uri']);
        }

        $this->assertGreaterThan(40, $checked);
    }

    // ---- CSRF -------------------------------------------------------------------------------------------------------------------------

    /** Runs the framework's CSRF check: it is skipped while the application runs its own unit tests. */
    private function realCsrf(): void
    {
        $this->app->instance('env', 'local');
    }

    public function test_every_state_changing_management_route_refuses_a_cookie_request_without_a_csrf_token(): void
    {
        $this->realCsrf();
        $admin = User::factory()->admin()->create();
        $statefulHost = 'http://'.config('sanctum.stateful')[0];
        $checked = 0;

        foreach ($this->routes('api/v1/', fn (LaravelRoute $route): bool => $this->management($route)) as $entry) {
            if (in_array($entry['method'], ['GET', 'HEAD'], true)) {
                continue;
            }

            $checked++;
            $this->app['auth']->forgetGuards();
            $response = $this->actingAs($admin)->withHeaders(['Referer' => $statefulHost.'/inbox', 'Origin' => $statefulHost])->json($entry['method'], $entry['uri']);

            $this->assertSame(419, $response->getStatusCode(), $entry['method'].' '.$entry['uri'].' must be CSRF-protected for the dashboard cookie');
            $this->assertSame('csrf_mismatch', $response->json('error.code'), $entry['method'].' '.$entry['uri']);
        }

        $this->assertGreaterThan(30, $checked);
    }

    public function test_a_bearer_token_needs_no_csrf_token_and_a_cookie_request_with_the_token_passes_the_check(): void
    {
        $this->realCsrf();
        $agent = User::factory()->agent()->create();
        $token = $agent->createToken('phone', ['staff'])->plainTextToken;

        // Mobile: no cookie, no CSRF (the bearer is the credential).
        $this->app['auth']->forgetGuards();
        $this->withToken($token)->postJson('/api/v1/me/presence/heartbeat', ['visible' => true])->assertOk();

        // The dashboard: the session cookie with the matching token header.
        $this->app['auth']->forgetGuards();
        $this->startSession();
        $host = 'http://'.config('sanctum.stateful')[0];
        $this->actingAs($agent)->withHeaders(['Referer' => $host.'/inbox', 'X-CSRF-TOKEN' => csrf_token()])->postJson('/api/v1/me/presence/heartbeat', ['visible' => true])->assertOk();
    }

    // ---- CORS -------------------------------------------------------------------------------------------------------------------------

    public function test_the_management_api_never_answers_with_cors_headers(): void
    {
        $admin = User::factory()->admin()->create();

        foreach ($this->routes('api/v1/', fn (LaravelRoute $route): bool => $this->management($route)) as $entry) {
            $this->app['auth']->forgetGuards();
            $preflight = $this->call('OPTIONS', $entry['uri'], [], [], [], ['HTTP_ORIGIN' => 'https://evil.example', 'HTTP_ACCESS_CONTROL_REQUEST_METHOD' => $entry['method']]);
            $this->assertNull($preflight->headers->get('Access-Control-Allow-Origin'), 'preflight of '.$entry['method'].' '.$entry['uri']);

            $this->app['auth']->forgetGuards();
            $actual = $this->actingAs($admin, 'sanctum')->withHeaders(['Origin' => 'https://evil.example'])->json($entry['method'], $entry['uri']);
            $this->assertNull($actual->headers->get('Access-Control-Allow-Origin'), $entry['method'].' '.$entry['uri']);
            $this->assertNull($actual->headers->get('Access-Control-Allow-Credentials'), $entry['method'].' '.$entry['uri']);
        }
    }

    public function test_cors_exists_only_on_the_public_widget_routes_and_only_for_an_allowed_origin_never_as_a_wildcard(): void
    {
        [$widget] = $this->chatWidget();
        $allowed = self::CUSTOMER_ORIGIN;

        $this->withHeaders(['Origin' => $allowed])->getJson('/api/v1/public/widgets/'.$widget->public_key.'/config')
            ->assertOk()->assertHeader('Access-Control-Allow-Origin', $allowed)->assertHeaderMissing('Access-Control-Allow-Credentials');

        $unlisted = $this->withHeaders(['Origin' => 'https://evil.example'])->getJson('/api/v1/public/widgets/'.$widget->public_key.'/config');
        $unlisted->assertForbidden();
        $this->assertNull($unlisted->headers->get('Access-Control-Allow-Origin'));

        // Nothing under the public API, whatever the call, ever says `*`.
        foreach ($this->routes('api/v1/public') as $entry) {
            $answer = $this->withHeaders(['Origin' => 'https://evil.example'])->json($entry['method'], $entry['uri']);
            $this->assertNotSame('*', $answer->headers->get('Access-Control-Allow-Origin'), $entry['method'].' '.$entry['uri']);
            $this->assertNull($answer->headers->get('Access-Control-Allow-Credentials'), $entry['method'].' '.$entry['uri']);
        }

        // A webhook is never a CORS surface.
        $this->withHeaders(['Origin' => $allowed])->postJson('/webhooks/openwa/'.self::ULID)->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    // ---- limiters ------------------------------------------------------------------------------------------------------------------------

    public function test_every_named_limiter_a_route_uses_is_defined(): void
    {
        $named = [];

        foreach (Route::getRoutes() as $route) {
            foreach (app('router')->gatherRouteMiddleware($route) as $middleware) {
                if (is_string($middleware) && preg_match('/(?:ThrottleRequests|ChatThrottle):([A-Za-z][A-Za-z0-9._-]*)$/D', $middleware, $matches) === 1) {
                    $named[$matches[1]] = true;
                }
            }
        }

        $this->assertGreaterThan(10, count($named));

        foreach (array_keys($named) as $limiter) {
            $this->assertNotNull(RateLimiter::limiter($limiter), "the rate limiter [{$limiter}] is used by a route but never defined");
        }
    }

    // ---- BOLA: another visitor / another user against every id-addressed route --------------------------------------------------------

    /**
     * The public routes addressed by a conversation ulid, with the body each needs.
     *
     * @return list<array{0: string, 1: string, 2: array<string, mixed>}>
     */
    private function publicConversationRoutes(): array
    {
        return [
            ['GET', 'messages', []],
            ['POST', 'messages', ['body' => 'hi there', 'client_msg_id' => '01HZZZZZZZZZZZZZZZZZZZZZZA']],
            ['POST', 'receipts', ['seen_upto' => 1]],
            ['POST', 'typing', ['typing' => true]],
            ['POST', 'end', []],
            ['POST', 'cancel', []],
            ['POST', 'rating', ['score' => 5]],
            ['POST', 'rating/skip', []],
        ];
    }

    public function test_another_visitor_is_a_stranger_to_every_conversation_route_and_changes_nothing(): void
    {
        [$widget, $category] = $this->chatWidget();
        $owner = $this->visitorSession($widget);
        $stranger = $this->visitorSession($widget);
        $chat = $this->activeChat($owner, $category, $this->availableAgent($category));
        Message::factory()->for($chat)->create(['seq' => 1, 'body' => 'private text of the owner']);
        $before = [$chat->fresh()->status, (string) $chat->fresh()->updated_at, Message::query()->count()];

        $unknown = null;

        foreach ($this->publicConversationRoutes() as [$method, $suffix, $body]) {
            $uri = '/api/v1/public/conversations/'.$chat->ulid.'/'.$suffix;
            $answer = $this->withHeaders($this->bearer($stranger))->json($method, $uri, $body);

            $this->assertSame(404, $answer->getStatusCode(), "{$method} {$suffix}: another visitor's conversation is a 404, never a 403 or data");
            $this->assertStringNotContainsString('private text', (string) $answer->getContent());

            // No oracle: the answer is the one for an id that does not exist.
            $missing = $this->withHeaders($this->bearer($stranger))->json($method, '/api/v1/public/conversations/'.self::ULID.'/'.$suffix, $body);
            $this->assertSame($missing->json(), $answer->json(), "{$method} {$suffix}: existing and missing look the same");
            $unknown = $answer->json('error.code');
        }

        $upload = $this->withHeaders($this->bearer($stranger))->post('/api/v1/public/conversations/'.$chat->ulid.'/attachments', ['file' => $this->pngUpload()], ['Accept' => 'application/json']);
        $this->assertSame(404, $upload->getStatusCode());
        $this->assertSame('not_found', $unknown);

        $this->assertSame($before, [$chat->fresh()->status, (string) $chat->fresh()->updated_at, Message::query()->count()], 'a stranger changed the conversation');

        // The owner is not a stranger (the control that makes the 404 above meaningful).
        $this->withHeaders($this->bearer($owner))->getJson('/api/v1/public/conversations/'.$chat->ulid.'/messages')->assertOk();
    }

    public function test_an_agent_that_is_not_on_the_chat_is_refused_on_every_conversation_route_and_an_administrator_is_not(): void
    {
        [$widget, $category] = $this->chatWidget();
        $owner = $this->availableAgent($category);
        $other = $this->availableAgent($category);
        $admin = User::factory()->admin()->create();
        $chat = $this->activeChat($this->visitorSession($widget), $category, $owner);
        $bodies = [
            'messages' => ['body' => 'intruder', 'client_msg_id' => '01HZZZZZZZZZZZZZZZZZZZZZZB'],
            'receipts' => ['seen_upto' => 1],
            'typing' => ['typing' => true],
            'transfer' => ['agent_id' => $other->id],
        ];
        $routes = $this->routes('api/v1/conversations/{conversation}');
        $messagesBefore = Message::query()->count();

        $this->assertGreaterThan(8, count($routes));

        foreach ($routes as $entry) {
            $uri = $this->concrete($entry['route'], ['conversation' => $chat->ulid]);
            $body = $bodies[trim(substr($uri, strlen('/api/v1/conversations/'.$chat->ulid)), '/')] ?? [];

            $this->app['auth']->forgetGuards();
            $refused = str_ends_with($uri, '/attachments')
                ? $this->actingAs($other, 'sanctum')->post($uri, ['file' => $this->pngUpload()], ['Accept' => 'application/json'])
                : $this->actingAs($other, 'sanctum')->json($entry['method'], $uri, $body);

            $this->assertContains($refused->getStatusCode(), [403, 404], $entry['method'].' '.$uri.': an agent that is not on the chat must be refused (got '.$refused->getStatusCode().')');
        }

        // Nothing the refused agent sent got through.
        $fresh = Conversation::query()->findOrFail($chat->id);
        $this->assertSame(ConversationStatus::Active, $fresh->status);
        $this->assertSame($owner->id, $fresh->assigned_agent_id);
        $this->assertSame($messagesBefore, Message::query()->count());
        $this->assertSame(0, Message::query()->where('body', 'intruder')->count());

        // An administrator may READ every conversation (acting in it is for its agent: receipts and typing are not an administrator's).
        foreach ($routes as $entry) {
            $uri = $this->concrete($entry['route'], ['conversation' => $chat->ulid]);
            $body = $bodies[trim(substr($uri, strlen('/api/v1/conversations/'.$chat->ulid)), '/')] ?? [];

            $this->app['auth']->forgetGuards();
            $status = $this->actingAs($admin, 'sanctum')->json($entry['method'], $uri, $body)->getStatusCode();

            $this->assertNotSame(401, $status, $entry['method'].' '.$uri);

            if ($entry['method'] === 'GET') {
                $this->assertNotSame(403, $status, $entry['method'].' '.$uri.': an administrator reads every conversation');
            }
        }
    }

    public function test_a_member_of_staff_cannot_remove_another_members_device_or_push_subscription(): void
    {
        $owner = User::factory()->agent()->create();
        $other = User::factory()->agent()->create();
        $device = DeviceToken::factory()->create(['user_id' => $owner->id]);
        $subscription = PushSubscription::factory()->create(['user_id' => $owner->id]);

        $this->app['auth']->forgetGuards();
        $this->actingAs($other, 'sanctum')->deleteJson('/api/v1/me/devices/'.$device->ulid)->assertNotFound();
        $this->app['auth']->forgetGuards();
        $this->actingAs($other, 'sanctum')->deleteJson('/api/v1/me/push-subscriptions/'.$subscription->ulid)->assertNotFound();

        $this->assertNotNull(DeviceToken::query()->find($device->id));
        $this->assertNotNull(PushSubscription::query()->find($subscription->id));
    }

    public function test_a_public_attachment_url_without_a_valid_signature_is_refused(): void
    {
        $attachment = Attachment::factory()->create();

        $this->getJson('/api/v1/public/attachments/'.$attachment->ulid)->assertForbidden();
        $this->getJson('/api/v1/public/attachments/'.$attachment->ulid.'?signature=abc&expires=9999999999')->assertForbidden();
    }

    /**
     * The rot guard of the BOLA sweep: every route with an id in its URL is either exercised above, admin-only (an agent is refused
     * as a class by the test of `adminOnly()`), a public widget key (the key is public by design), or a signed URL.
     */
    public function test_every_route_with_an_id_in_its_url_is_covered_by_the_bola_sweep(): void
    {
        $covered = [
            'api/v1/public/conversations/{ulid}/' => 'a visitor against another visitor (test_another_visitor_is_a_stranger...)',
            'api/v1/conversations/{conversation}' => 'an agent against a chat that is not theirs',
            'api/v1/me/devices/{device}' => 'own rows only',
            'api/v1/me/push-subscriptions/{subscription}' => 'own rows only',
            'api/v1/auth/tokens/{token}' => 'own tokens only (StaffTokensApiTest)',
            'api/v1/public/attachments/{attachment}' => 'signed URL',
            'api/v1/public/widgets/{key}/' => 'the widget key is public; the Origin gate decides',
            'webhooks/openwa/{session}' => 'HMAC of the raw body with the secret of that session',
        ];
        $uncovered = [];

        foreach (Route::getRoutes() as $route) {
            $uri = $route->uri();

            if ($route->parameterNames() === [] || ! (str_starts_with($uri, 'api/') || str_starts_with($uri, 'webhooks/'))) {
                continue;
            }

            if ($this->management($route) && $this->adminOnly($route)) {
                continue;
            }

            $matched = false;

            foreach (array_keys($covered) as $prefix) {
                if (str_starts_with($uri, $prefix)) {
                    $matched = true;
                }
            }

            if (! $matched) {
                $uncovered[] = implode('|', $route->methods()).' '.$uri;
            }
        }

        $this->assertSame([], $uncovered, 'These id-addressed routes are not in the BOLA sweep: add a case (or admin-gate them).');
    }
}
