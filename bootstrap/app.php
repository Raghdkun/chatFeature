<?php

use App\Exceptions\ApiErrorRenderer;
use App\Http\Middleware\EnforceAuthFeatures;
use App\Http\Middleware\EnsureAdmin;
use App\Http\Middleware\EnsureChatAccess;
use App\Http\Middleware\EnsureSessionIsValid;
use App\Http\Middleware\HandleAppearance;
use App\Http\Middleware\HandleInertiaRequests;
use App\Http\Middleware\InstallGate;
use App\Http\Middleware\SetLocale;
use App\Support\RouteFiles;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Middleware\AddLinkHeadersForPreloadedAssets;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\SubstituteBindings;
use Illuminate\Support\Facades\Route;

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

        // Not installed yet: web -> /setup, API -> 503 not_installed. First in the global stack.
        $middleware->prepend(InstallGate::class);

        $middleware->encryptCookies(except: ['appearance', 'sidebar_state']);

        $middleware->alias([
            // For API groups: signed-in users without admin/agent access are turned away.
            'chat.access' => EnsureChatAccess::class,
            // For API groups: revoked / deactivated users are turned away even with a valid token.
            'session.valid' => EnsureSessionIsValid::class,
            // Admin-only routes (after auth, session.valid and chat.access).
            'admin' => EnsureAdmin::class,
        ]);

        // Bearer-only group for the public widget API and webhooks (deliberately NOT stateful).
        $middleware->group('widget', [
            SubstituteBindings::class,
        ]);

        $middleware->web(append: [
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
        // The setup token must never be flashed back into a form.
        $exceptions->dontFlash(['token']);

        // `api/*` errors use the documented envelope {error:{code,message,details?}} (docs/contracts/rest-shapes.md).
        $exceptions->render(fn (Throwable $e, Request $request) => ApiErrorRenderer::render($e, $request));

        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
