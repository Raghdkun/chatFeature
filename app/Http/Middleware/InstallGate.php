<?php

namespace App\Http\Middleware;

use App\Domain\Install\InstallState;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Global middleware. While the app is not installed, web requests are redirected to the setup
 * wizard and API/JSON requests get `503 {"error":"not_installed"}`. Exempt: the health check,
 * the wizard itself and static assets. Once the lock exists this is a no-op.
 *
 * It runs before the session / cookie middleware, so it also catches a missing APP_KEY (which
 * would otherwise crash the wizard before it could explain anything).
 */
final class InstallGate
{
    /** Paths reachable before installation (health check, wizard, built assets). */
    private const EXEMPT = ['up', 'setup', 'setup/*', 'build/*', 'favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'robots.txt'];

    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if ($this->state->isInstalled()) {
            return $next($request);
        }

        if ($request->is('up')) {
            return $next($request);
        }

        if ((string) config('app.key') === '') {
            return $this->wantsJson($request)
                ? response()->json(['error' => 'not_installed'], 503)
                : response(
                    "PNE Chat is not configured yet: APP_KEY is missing.\nRun `php artisan chat:bootstrap-secrets` (or `php artisan key:generate`) and reload this page.\n",
                    503,
                    ['Content-Type' => 'text/plain; charset=UTF-8'],
                );
        }

        if ($request->is(self::EXEMPT)) {
            return $next($request);
        }

        return $this->wantsJson($request)
            ? response()->json(['error' => 'not_installed'], 503)
            : redirect('/setup');
    }

    private function wantsJson(Request $request): bool
    {
        return $request->is('api/*', 'webhooks/*') || $request->expectsJson();
    }
}
