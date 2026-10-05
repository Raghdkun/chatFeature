<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The headers every machine-facing response (management API, public widget API, webhooks) carries (it also runs as a GLOBAL middleware, so
 * the answers that never reach the group's own middleware, a 401 from `auth`, an unknown path, a wrong method, carry them too; any other
 * response only gets `nosniff`): `X-Content-Type-Options: nosniff`
 * (a JSON answer or an attachment is never sniffed into something executable), `Referrer-Policy: no-referrer`, and HSTS on a request that
 * came in over https (`SecurityHeaders::strictTransportSecurity()`). Headers a response already set are kept. The browser-facing hardening
 * (CSP, framing, permissions) lives in `SecurityHeaders`.
 */
final class ApiSecurityHeaders
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $headers = $response->headers;

        if (! $headers->has('X-Content-Type-Options')) {
            $headers->set('X-Content-Type-Options', 'nosniff');
        }

        // Pages keep the policy of `SecurityHeaders` (and the embeddable ones their own): only machine-facing paths get this one here.
        if (! $request->is('api/*', 'webhooks/*')) {
            return $response;
        }

        if (! $headers->has('Referrer-Policy')) {
            $headers->set('Referrer-Policy', 'no-referrer');
        }

        $strictTransport = SecurityHeaders::strictTransportSecurity($request);

        if ($strictTransport !== null && ! $headers->has('Strict-Transport-Security')) {
            $headers->set('Strict-Transport-Security', $strictTransport);
        }

        return $response;
    }
}
