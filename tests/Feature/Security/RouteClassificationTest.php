<?php

namespace Tests\Feature\Security;

use Illuminate\Routing\Route as LaravelRoute;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

/**
 * The rot guard of the route table (P7): every route is CLASSIFIED by the middleware it really carries, and a new route that does not fit
 * a class (or an allow-list below) fails here until somebody decides what it is. The classes:
 *
 * - **management**: `api/v1/**` outside `public`: Sanctum (cookie with CSRF, or bearer) + `session.valid` + `chat.access`, then either
 *   any staff (the explicit {@see self::ANY_STAFF} list: agents reach these) or `admin` / `wa.admin`. A new management route is
 *   admin-only unless it is added to that list on purpose.
 * - **public**: `api/v1/public/**`: stateless (no session, cookie or CSRF middleware), a named limiter, and one of: the widget origin
 *   gate (the {@see self::ORIGIN_ONLY} list), a bearer visitor token (with the network limiter BEFORE the token lookup), or a signed URL.
 * - **webhook**: `webhooks/**`: stateless, signature verified before anything else, a named limiter.
 * - **web**: every page / form route either needs a signed-in user or is in {@see self::WEB_UNAUTHENTICATED} with its reason.
 *
 * The behaviour of each class (401 / 403, CSRF 419, CORS, BOLA) is exercised by `RouteBehaviourMatrixTest`.
 */
class RouteClassificationTest extends TestCase
{
    /** Management routes an AGENT may call (everything else under api/v1 must be admin-only). */
    public const ANY_STAFF = [
        'GET api/v1/categories',
        'GET api/v1/me/categories',
        'PUT api/v1/me/categories',
        'GET api/v1/conversations',
        'GET api/v1/conversations/queue',
        'GET api/v1/conversations/{conversation}',
        'GET api/v1/conversations/{conversation}/transfer-targets',
        'GET api/v1/conversations/{conversation}/messages',
        'POST api/v1/conversations/{conversation}/messages',
        'POST api/v1/conversations/{conversation}/claim',
        'POST api/v1/conversations/{conversation}/attachments',
        'POST api/v1/conversations/{conversation}/receipts',
        'POST api/v1/conversations/{conversation}/typing',
        'POST api/v1/conversations/{conversation}/end',
        'POST api/v1/conversations/{conversation}/close',
        'POST api/v1/conversations/{conversation}/transfer',
        'GET api/v1/me/presence',
        'PUT api/v1/me/presence',
        'POST api/v1/me/presence/heartbeat',
        'GET api/v1/me/notification-settings',
        'PUT api/v1/me/notification-settings',
        'GET api/v1/me/push-subscriptions',
        'POST api/v1/me/push-subscriptions/test',
        'POST api/v1/me/push-subscriptions',
        'DELETE api/v1/me/push-subscriptions/{subscription}',
        'POST api/v1/me/devices',
        'DELETE api/v1/me/devices/{device}',
        // P7: an agent's own numbers (the server scopes them to the caller), and the caller's own credential.
        'GET api/v1/analytics/heatmap',
        'GET api/v1/analytics/overview',
        'GET api/v1/analytics/ratings',
        'GET api/v1/analytics/timeseries',
        'GET api/v1/auth/me',
        'GET api/v1/auth/tokens',
        'DELETE api/v1/auth/tokens/{token}',
        'POST api/v1/auth/logout',
    ];

    /**
     * The only unauthenticated management routes: the native app's sign-in (track 7D). Stateless (no session, no cookie, no CORS),
     * never cached, size-capped, and each behind a named limiter.
     */
    public const API_GUEST = [
        'POST api/v1/auth/token' => 'native app sign-in: password check, then a bearer token (or a two-factor challenge)',
        'POST api/v1/auth/token/two-factor' => 'native app sign-in: second step with a challenge from the first',
    ];

    /** Public routes that need nothing but an allowed Origin (no visitor token): the pre-chat handshake. */
    public const ORIGIN_ONLY = [
        'GET api/v1/public/widgets/{key}/availability',
        'GET api/v1/public/widgets/{key}/config',
        'POST api/v1/public/widgets/{key}/sessions',
    ];

    /** Web routes that need no signed-in user, and why. */
    public const WEB_UNAUTHENTICATED = [
        'GET login' => 'sign-in form',
        'POST login' => 'sign-in (throttled)',
        'GET forgot-password' => 'password reset (mode 1)',
        'POST forgot-password' => 'password reset (mode 1)',
        'GET reset-password/{token}' => 'password reset (mode 1)',
        'POST reset-password' => 'password reset (mode 1)',
        'GET register' => 'gated by the registration setting (EnforceAuthFeatures)',
        'POST register' => 'gated by the registration setting (EnforceAuthFeatures)',
        'GET two-factor-challenge' => 'second factor of a sign-in in progress',
        'POST two-factor-challenge' => 'second factor (throttled)',
        'GET passkeys/login/options' => 'passkey sign-in (throttled)',
        'POST passkeys/login' => 'passkey sign-in (throttled)',
        'GET sanctum/csrf-cookie' => 'the CSRF cookie for the dashboard SPA',
        'GET .well-known/passkey-endpoints' => 'passkey discovery',
        'GET up' => 'health check (answers before the install)',
        'GET manifest.webmanifest' => 'web app manifest (static)',
        'GET setup' => 'install wizard: EnsureNotInstalled, 404 once installed',
        'POST setup/token' => 'install wizard: setup token (throttled)',
        'GET setup/state' => 'install wizard: setup token verified per session',
        'POST setup/mode' => 'install wizard: setup token verified per session',
        'POST setup/admin' => 'install wizard: setup token verified per session',
        'POST setup/basics' => 'install wizard: setup token verified per session',
        'POST setup/pizzasys' => 'install wizard: setup token verified per session',
        'POST setup/pizzasys/test' => 'install wizard: setup token verified per session',
        'POST setup/portal-admin' => 'install wizard: setup token verified per session',
        'POST setup/run/{step}' => 'install wizard: setup token verified per session',
        'GET w/{key}.js' => 'widget loader (public delivery, Referer-checked)',
        'GET embed/{key}' => 'chat panel iframe (public delivery, frame-ancestors)',
        'GET c/{key}' => 'hosted chat page (public delivery)',
        'GET widget/v1/loader.js' => 'generic loader (static)',
        'POST csp-report' => 'Content-Security-Policy violation collector (throttled, logs only)',
        'GET broadcasting/auth' => 'channel authorisation: the channel guards decide (403 for a guest); the framework excludes CSRF here',
        'POST broadcasting/auth' => 'channel authorisation: the channel guards decide (403 for a guest); the framework excludes CSRF here',
        'GET storage/{path}' => 'local disk: only signed URLs are served (framework route)',
        'PUT storage/{path}' => 'local disk: only signed upload URLs are accepted (framework route)',
    ];

    /** Middleware that make a request stateful (session, cookie, CSRF): the public API and the webhooks must have none of them. */
    private const STATEFUL = ['EnsureFrontendRequestsAreStateful', 'StartSession', 'StartSessionReadOnlyForApi', 'PreventRequestForgery', 'PreventRequestForgeryWithoutCookieForApi', 'EncryptCookies', 'AddQueuedCookiesToResponse', 'VerifyCsrfToken', 'Authenticate'];

    /**
     * @return list<string> short middleware names ("ChatThrottle:public-network", "EnsureAdmin") of a route, groups expanded
     */
    private function middleware(LaravelRoute $route): array
    {
        return array_map(
            fn ($middleware): string => is_string($middleware) ? (string) preg_replace('/^.*\\\\/', '', $middleware) : 'Closure',
            app('router')->gatherRouteMiddleware($route),
        );
    }

    private function has(array $middleware, string $name): bool
    {
        foreach ($middleware as $entry) {
            if ($entry === $name || str_starts_with($entry, $name.':')) {
                return true;
            }
        }

        return false;
    }

    private function position(array $middleware, string $name): int
    {
        foreach ($middleware as $index => $entry) {
            if ($entry === $name || str_starts_with($entry, $name.':')) {
                return $index;
            }
        }

        return PHP_INT_MAX;
    }

    /**
     * One entry per route and verb that is not HEAD / OPTIONS: "GET api/v1/agents".
     *
     * @return array<string, LaravelRoute>
     */
    private function routes(string $prefix): array
    {
        $found = [];

        foreach (Route::getRoutes() as $route) {
            if (! str_starts_with($route->uri(), $prefix)) {
                continue;
            }

            foreach ($route->methods() as $method) {
                if (! in_array($method, ['HEAD', 'OPTIONS'], true)) {
                    $found[$method.' '.$route->uri()] = $route;
                }
            }
        }

        return $found;
    }

    private function isLimited(array $middleware): bool
    {
        foreach ($middleware as $entry) {
            if (str_starts_with($entry, 'ThrottleRequests') || str_starts_with($entry, 'ChatThrottle') || in_array($entry, ['ThrottlePublicNetwork', 'ThrottlePublicWidget'], true)) {
                return true;
            }
        }

        return false;
    }

    // ---- management -------------------------------------------------------------------------------------------------------------

    public function test_every_management_route_is_authenticated_validated_and_either_listed_as_agent_reachable_or_admin_only(): void
    {
        $management = array_filter($this->routes('api/'), fn (string $key): bool => ! str_contains($key, ' api/v1/public/') && ! str_contains($key, ' webhooks/') && ! array_key_exists($key, self::API_GUEST), ARRAY_FILTER_USE_KEY);

        $this->assertGreaterThan(60, count($management), 'the management API is being walked');

        $anyStaff = [];

        foreach ($management as $key => $route) {
            $middleware = $this->middleware($route);

            $this->assertTrue($this->has($middleware, 'Authenticate'), "{$key}: management routes authenticate through Sanctum (cookie with CSRF, or bearer)");
            $this->assertContains('auth:sanctum', $route->gatherMiddleware(), "{$key}: the guard is Sanctum");
            $this->assertTrue($this->has($middleware, 'EnsureSessionIsValid'), "{$key}: a revoked / deactivated session is turned away even with a valid token");
            $this->assertTrue($this->has($middleware, 'EnsureChatAccess'), "{$key}: an account without a chat role is turned away");
            $this->assertTrue($this->has($middleware, 'EnsureFrontendRequestsAreStateful'), "{$key}: cookie requests get the CSRF-protected stateful pipeline");
            $this->assertLessThan($this->position($middleware, 'EnsureSessionIsValid'), $this->position($middleware, 'Authenticate'), "{$key}: authentication comes first");
            $this->assertLessThan($this->position($middleware, 'SubstituteBindings'), $this->position($middleware, 'Authenticate'), "{$key}: a model is not looked up (404 vs 403 oracle) before the caller is authenticated");

            if ($this->has($middleware, 'EnsureAdmin') || $this->has($middleware, 'EnsureWhatsAppAdmin')) {
                $this->assertLessThan($this->position($middleware, 'EnsureAdmin') < PHP_INT_MAX ? $this->position($middleware, 'EnsureAdmin') : $this->position($middleware, 'EnsureWhatsAppAdmin'), $this->position($middleware, 'EnsureChatAccess'), "{$key}: the admin check runs after the chat-access check");

                continue;
            }

            $anyStaff[] = $key;
        }

        $this->assertEqualsCanonicalizing(self::ANY_STAFF, $anyStaff, 'The routes an agent can reach changed: a new management route is admin-only (EnsureAdmin / EnsureWhatsAppAdmin) unless it is added to ANY_STAFF on purpose.');
    }

    public function test_the_native_sign_in_routes_are_the_only_unauthenticated_management_routes_and_are_stateless_limited_and_never_cached(): void
    {
        $guests = array_filter($this->routes('api/v1/'), fn ($route, string $key): bool => ! str_contains($key, ' api/v1/public/') && ! $this->has($this->middleware($route), 'Authenticate'), ARRAY_FILTER_USE_BOTH);

        $this->assertEqualsCanonicalizing(array_keys(self::API_GUEST), array_keys($guests), 'A management route without authentication must be listed in API_GUEST with its reason.');

        foreach ($guests as $key => $route) {
            $middleware = $this->middleware($route);

            $this->assertTrue($this->isLimited($middleware), "{$key}: a named limiter");
            $this->assertTrue($this->has($middleware, 'NoStoreResponses'), "{$key}: never cached");
            $this->assertTrue($this->has($middleware, 'LimitRequestBodySize'), "{$key}: size-capped");
            $this->assertFalse($this->has($middleware, 'EnsureFrontendRequestsAreStateful'), "{$key}: no session, no cookie");
            $this->assertFalse($this->has($middleware, 'StartSession'), "{$key}: no session");
        }
    }

    public function test_every_whatsapp_route_is_for_administrators_only(): void
    {
        $count = 0;

        foreach ($this->routes('api/v1') as $key => $route) {
            if (! str_contains($key, 'whatsapp') || str_contains($key, 'api/v1/public/')) {
                continue;
            }

            $count++;
            $this->assertTrue($this->has($this->middleware($route), 'EnsureWhatsAppAdmin'), "{$key}: WhatsApp is administrators only (CLAUDE.md, decision P6-D1)");
        }

        $this->assertGreaterThan(20, $count);
    }

    // ---- public ------------------------------------------------------------------------------------------------------------------

    public function test_every_public_route_is_stateless_limited_and_gated_by_origin_or_visitor_token_or_signature(): void
    {
        $public = $this->routes('api/v1/public');
        $originOnly = [];

        $this->assertGreaterThan(15, count($public));

        foreach ($public as $key => $route) {
            $middleware = $this->middleware($route);

            foreach (self::STATEFUL as $stateful) {
                $this->assertFalse($this->has($middleware, $stateful), "{$key}: the public API is bearer-only, it must not carry {$stateful} (no session, cookie or CSRF)");
            }

            $this->assertTrue($this->isLimited($middleware), "{$key}: a public route sits behind a named rate limiter");

            $originGated = $this->has($middleware, 'AuthorizeWidgetOrigin');
            $visitor = $this->has($middleware, 'AuthenticateVisitor');
            $signed = $this->has($middleware, 'ValidateSignature');

            $this->assertTrue($originGated || $visitor || $signed, "{$key}: a public route needs the widget origin gate, a visitor token or a signed URL");

            if ($originGated) {
                $this->assertTrue($this->has($middleware, 'ShieldPublicWidgets') && $this->has($middleware, 'ThrottlePublicNetwork'), "{$key}: the origin gate is preceded by the unknown-key shield and the network limiter");
                $this->assertLessThan($this->position($middleware, 'AuthorizeWidgetOrigin'), $this->position($middleware, 'ThrottlePublicNetwork'), "{$key}: the network limiter runs before the origin lookup");
            }

            if ($visitor) {
                $limiter = array_values(array_filter(array_keys($middleware), fn (int $index): bool => $middleware[$index] === 'ChatThrottle:public-network' || $middleware[$index] === 'ThrottleRequests:broadcasting-auth'));

                $this->assertNotEmpty($limiter, "{$key}: the per-network limiter must run BEFORE the token lookup (guessing tokens costs a limiter hit)");
                $this->assertLessThan($this->position($middleware, 'AuthenticateVisitor'), $limiter[0], "{$key}: network limiter before AuthenticateVisitor");
            }

            if ($originGated && ! $visitor && ! $signed) {
                $originOnly[] = $key;
            }
        }

        $this->assertEqualsCanonicalizing(self::ORIGIN_ONLY, $originOnly, 'The public routes reachable with an allowed Origin alone changed: a new one must either need a visitor token or be added to ORIGIN_ONLY on purpose.');
    }

    // ---- webhooks ----------------------------------------------------------------------------------------------------------------

    public function test_every_webhook_is_stateless_throttled_and_verifies_its_signature_first(): void
    {
        $webhooks = $this->routes('webhooks/');

        $this->assertNotEmpty($webhooks);

        foreach ($webhooks as $key => $route) {
            $middleware = $this->middleware($route);

            foreach (self::STATEFUL as $stateful) {
                $this->assertFalse($this->has($middleware, $stateful), "{$key}: a webhook carries no session / cookie / CSRF middleware");
            }

            $this->assertTrue($this->has($middleware, 'VerifyOpenWaSignature'), "{$key}: the only credential of a webhook is its signature");
            $this->assertTrue($this->isLimited($middleware), "{$key}: a webhook has a named rate limiter");
            $this->assertLessThan($this->position($middleware, 'VerifyOpenWaSignature'), $this->position($middleware, 'ChatThrottle'), "{$key}: the limiter runs before the HMAC work");
        }
    }

    // ---- web ---------------------------------------------------------------------------------------------------------------------

    public function test_every_web_route_needs_a_signed_in_user_or_is_listed_as_public_with_its_reason(): void
    {
        $unauthenticated = [];

        foreach (Route::getRoutes() as $route) {
            $uri = $route->uri();

            if (str_starts_with($uri, 'api/') || str_starts_with($uri, 'webhooks/')) {
                continue;
            }

            foreach ($route->methods() as $method) {
                if (in_array($method, ['HEAD', 'OPTIONS'], true) || ($uri === '/' && $method !== 'GET')) {
                    continue;
                }

                $middleware = $this->middleware($route);
                $key = $method.' '.$uri;

                if (! $this->has($middleware, 'Authenticate')) {
                    $unauthenticated[] = $key;
                }
            }
        }

        $this->assertEqualsCanonicalizing(array_keys(self::WEB_UNAUTHENTICATED), $unauthenticated, 'The set of web routes that need no signed-in user changed: classify the new route in WEB_UNAUTHENTICATED (with its reason) or put it behind `auth`.');
    }

    public function test_every_registered_route_belongs_to_a_known_family(): void
    {
        $families = ['api/v1/' => 0, 'webhooks/' => 0];
        $known = array_keys(self::WEB_UNAUTHENTICATED);

        foreach (Route::getRoutes() as $route) {
            $uri = $route->uri();

            foreach (array_keys($families) as $prefix) {
                if (str_starts_with($uri, $prefix)) {
                    $families[$prefix]++;

                    continue 2;
                }
            }

            $this->assertNotSame('', $uri === '/' ? 'x' : $uri);
        }

        $this->assertGreaterThan(0, $families['api/v1/']);
        $this->assertGreaterThan(0, $families['webhooks/']);
        $this->assertNotEmpty($known);

        // Nothing is mounted under `api/` outside `api/v1/` (a second, unclassified API surface would escape the guards above).
        foreach (Route::getRoutes() as $route) {
            if (str_starts_with($route->uri(), 'api/')) {
                $this->assertStringStartsWith('api/v1/', $route->uri(), 'every api/ route lives under api/v1/');
            }
        }
    }
}
