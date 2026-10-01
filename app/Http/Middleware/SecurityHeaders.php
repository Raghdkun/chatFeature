<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Baseline hardening for dashboard/auth pages (web group): they may only be framed by this origin, so a
 * third-party site cannot overlay the login page or an admin screen. Responses that set their own framing
 * policy (the embeddable /embed and /c pages send `frame-ancestors <widget domains>`) are left untouched.
 */
final class SecurityHeaders
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        $headers = $response->headers;

        $csp = (string) $headers->get('Content-Security-Policy', '');
        $setsOwnFraming = str_contains($csp, 'frame-ancestors') || $headers->has('X-Frame-Options');

        if (! $setsOwnFraming) {
            $headers->set('X-Frame-Options', 'SAMEORIGIN');
            $headers->set('Content-Security-Policy', trim($csp === '' ? "frame-ancestors 'self'" : $csp."; frame-ancestors 'self'"));
        }

        if (! $headers->has('X-Content-Type-Options')) {
            $headers->set('X-Content-Type-Options', 'nosniff');
        }

        if (! $headers->has('Referrer-Policy')) {
            $headers->set('Referrer-Policy', 'strict-origin-when-cross-origin');
        }

        return $response;
    }
}
