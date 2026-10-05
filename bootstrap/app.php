<?php

use App\Exceptions\ApiErrorRenderer;
use App\Http\Middleware\ApiSecurityHeaders;
use App\Http\Middleware\AuthenticateStaffSession;
use App\Http\Middleware\AuthenticateVisitor;
use App\Http\Middleware\EnforceAuthFeatures;
use App\Http\Middleware\EnsureAdmin;
use App\Http\Middleware\EnsureChatAccess;
use App\Http\Middleware\EnsureSessionIsValid;
use App\Http\Middleware\EnsureWhatsAppAdmin;
use App\Http\Middleware\HandleAppearance;
use App\Http\Middleware\HandleInertiaRequests;
use App\Http\Middleware\InstallGate;
use App\Http\Middleware\SecurityHeaders;
use App\Http\Middleware\SetLocale;
use App\Http\Middleware\TrustInstalledAppHost;
use App\Support\RouteFiles;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Exceptions\ThrottleRequestsException;
use Illuminate\Http\Middleware\AddLinkHeadersForPreloadedAssets;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Support\Facades\Route;
use Inertia\Inertia;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        channels: __DIR__.'/../routes/channels.php',
        health: '/up',
        then: function (): void {
            // Public visitor API: bearer-only, no cookies / sessions / CSRF.
            Route::prefix('api/v1/public')
                ->middleware('widget')
                ->group(fn () => RouteFiles::require(base_path('routes/api/public')));

            // Inbound third-party webhooks (OpenWA ...): signature-verified per route.
            Route::prefix('webhooks')
                ->middleware('widget')
                ->group(fn () => RouteFiles::require(base_path('routes/webhooks')));
        },
    )
    ->withMiddleware(function (Middleware $middleware): void {
        // Dashboard SPA calls the management API with the session cookie (+ XSRF header); mobile uses bearer tokens.
        $middleware->statefulApi();
        $middleware->api(prepend: [TrustInstalledAppHost::class], append: [ApiSecurityHeaders::class]);

        // Not installed yet: web -> /setup, API -> 503 not_installed. First in the global stack.
        $middleware->prepend(InstallGate::class);
        // Outermost for the answers no group middleware ever sees: a 401 from `auth`, an unknown path, a wrong method.
        $middleware->append(ApiSecurityHeaders::class);

        $middleware->encryptCookies(except: ['appearance', 'sidebar_state']);

        $middleware->alias([
            // For API groups: signed-in users without admin/agent access are turned away.
            'chat.access' => EnsureChatAccess::class,
            // For API groups: revoked / deactivated users are turned away even with a valid token.
            'session.valid' => EnsureSessionIsValid::class,
            // Admin-only routes (after auth, session.valid and chat.access).
            'admin' => EnsureAdmin::class,
            // Public chat API: bearer visitor token (`vt_...`) -> request attributes `visitor_session` / `visitor`.
            'visitor' => AuthenticateVisitor::class,
            // WhatsApp management API and pages: active administrators only, through WhatsAppPolicy (P6-D1).
            'wa.admin' => EnsureWhatsAppAdmin::class,
        ]);

        // Bearer-only group for the public widget API and webhooks (deliberately NOT stateful).
        $middleware->group('widget', [
            SubstituteBindings::class,
            ApiSecurityHeaders::class,
        ]);

        // Outermost in the group, so the security headers also reach the error page an inner middleware (route model binding, the session
        // checks) turns an exception into: the pipeline hands that response back to the layers around it.
        $middleware->web(prepend: [SecurityHeaders::class]);

        $middleware->web(append: [
            // A password change or reset ends every OTHER session of that account, pages included. Until now only the stateful API
            // calls noticed (Sanctum's variant), so the old tab's pages kept answering while its background requests got 401 and it
            // reloaded itself in a loop. The session of the person who changed it survives (the hash is stored again after the response).
            AuthenticateStaffSession::class,
            HandleAppearance::class,
            SetLocale::class,
            EnforceAuthFeatures::class,
            HandleInertiaRequests::class,
            AddLinkHeadersForPreloadedAssets::class,
            EnsureSessionIsValid::class,
            EnsureChatAccess::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Secrets must never be flashed back into a form (and so into the session store) when it is rejected:
        // the setup token and the Auth Portal service/NATS tokens (wizard: nested per environment, settings: flat).
        $exceptions->dontFlash([
            'token',
            'service_token',
            'nats_token',
            'environments.production.service_token',
            'environments.production.nats_token',
            'environments.testing.service_token',
            'environments.testing.nats_token',
            // WhatsApp settings (P6): the OpenWA API key; never flashed back into a rejected form.
            'api_key',
            'webhook_secret',
            // The web two-factor form and the native sign-in post these; never flashed back after a validation error.
            'code',
            'recovery_code',
            'challenge',
        ]);

        // `api/*` errors use the documented envelope {error:{code,message,details?}} (docs/contracts/rest-shapes.md).
        $exceptions->render(fn (Throwable $e, Request $request) => ApiErrorRenderer::render($e, $request));

        // A throttled FORM of the dashboard (sign-in, the two-factor code, a reset request ...) used to open a bare "429" box over the page with no
        // word about how long to wait. It goes back to the form instead, with the wait as a toast. (Pages and the API keep their own 429.)
        $exceptions->render(function (ThrottleRequestsException $e, Request $request) {
            if ($request->is('api/*') || ! $request->header('X-Inertia') || $request->isMethod('GET') || ! $request->hasSession()) {
                return null;
            }

            $wait = (int) ($e->getHeaders()['Retry-After'] ?? 0);

            Inertia::flash('toast', [
                'type' => 'error',
                'message' => $wait > 0
                    ? __('Too many attempts. Try again in :seconds seconds.', ['seconds' => $wait])
                    : __('Too many attempts. Please wait a moment and try again.'),
            ]);

            return back();
        });

        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
