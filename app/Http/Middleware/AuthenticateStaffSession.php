<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Auth\SessionGuard;
use Illuminate\Session\Middleware\AuthenticateSession;

/**
 * Laravel's "sign this session out when the password changed" check for the dashboard PAGES (the stateful API calls have Sanctum's
 * variant). It only knows session guards: a request authenticated another way (a Sanctum token acting on a page route, a test) has no
 * remember cookie or password hash to compare and is left alone instead of failing.
 */
class AuthenticateStaffSession extends AuthenticateSession
{
    public function handle($request, Closure $next)
    {
        if (! $this->auth->guard() instanceof SessionGuard) {
            return $next($request);
        }

        return parent::handle($request, $next);
    }
}
