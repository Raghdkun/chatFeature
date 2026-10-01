<?php

namespace App\Http\Middleware;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\SessionContext;
use App\Domain\Install\InstallState;
use App\Http\Middleware\Concerns\EndsStaffSession;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Asks the active AuthDriver whether the signed-in session is still valid (deactivated account, revoked upstream
 * session in mode 2).
 *
 *  - Revoked: the user is signed out (401 JSON / redirect to the login page).
 *  - Unavailable (mode 2, auth portal down beyond the grace window): the session is KEPT and the request answered
 *    503 (`auth_unavailable`), so a portal outage never logs anybody out.
 *
 * The verdict is memoised on the request because the middleware runs both in the `web` group and as the
 * `session.valid` alias of a route group.
 */
final class EnsureSessionIsValid
{
    use EndsStaffSession;

    private const VERDICT_ATTRIBUTE = 'auth.session_verdict';

    /** Seconds a client is told to wait before retrying after a 503. */
    private const RETRY_AFTER_SECONDS = 30;

    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $this->state->isInstalled() ? $request->user() : null;

        if (! $user instanceof User) {
            return $next($request);
        }

        $verdict = $request->attributes->get(self::VERDICT_ATTRIBUTE);

        if (! $verdict instanceof SessionVerdict) {
            $verdict = app(AuthDriver::class)->validateSession($user, SessionContext::fromRequest($request));
            $request->attributes->set(self::VERDICT_ATTRIBUTE, $verdict);
        }

        if ($verdict === SessionVerdict::Revoked) {
            return $this->endSession($request, 'session_revoked', __('Your session has ended. Please sign in again.'), 401);
        }

        // Signing out must keep working during an outage.
        if ($verdict === SessionVerdict::Unavailable && ! $request->routeIs('logout')) {
            return $this->unavailable($request);
        }

        return $next($request);
    }

    private function unavailable(Request $request): Response
    {
        $message = __('The sign-in service (Auth Portal) is unreachable right now. You are still signed in; please try again in a few minutes.');

        if ($request->expectsJson() || $request->header('X-Inertia') !== null) {
            return response()
                ->json(['error' => ['code' => 'auth_unavailable', 'message' => $message]], 503)
                ->header('Retry-After', (string) self::RETRY_AFTER_SECONDS);
        }

        return response()
            ->view('auth.unavailable', ['message' => $message], 503)
            ->header('Retry-After', (string) self::RETRY_AFTER_SECONDS);
    }
}
