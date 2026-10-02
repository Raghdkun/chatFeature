<?php

namespace App\Http\Middleware\Auth;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Nothing a credential endpoint answers may be kept by a cache, a proxy or the client's HTTP cache: the answer of a sign-in is a bearer
 * token, and even an error says something about an account. Errors included: this middleware wraps the route, so it also decorates the
 * response the exception handler makes of a refusal or a throttle.
 */
final class NoStoreResponses
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);

        $response->headers->set('Cache-Control', 'no-store, private');
        $response->headers->set('Pragma', 'no-cache');

        return $response;
    }
}
