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
 * Asks the active AuthDriver whether the signed-in session is still valid (deactivated account,
 * revoked upstream session in mode 2). Cheap for Fortify; P2 adds the cached portal revalidation.
 */
final class EnsureSessionIsValid
{
    use EndsStaffSession;

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

        $verdict = app(AuthDriver::class)->validateSession($user, SessionContext::fromRequest($request));

        if ($verdict === SessionVerdict::Revoked) {
            return $this->endSession($request, 'session_revoked', __('Your session has ended. Please sign in again.'), 401);
        }

        return $next($request);
    }
}
