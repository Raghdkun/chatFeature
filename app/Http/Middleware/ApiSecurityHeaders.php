<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The headers every machine-facing response (management API, public widget API, webhooks) carries: `X-Content-Type-Options: nosniff`
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
