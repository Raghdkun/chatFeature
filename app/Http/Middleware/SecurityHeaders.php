<?php

namespace App\Http\Middleware;

use App\Support\Security\ContentSecurityPolicy;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Vite;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\ResponseHeaderBag;

/**
 * Hardening of dashboard / auth pages (web group), docs/security.md "Security headers and Content-Security-Policy".
 *
 * - Framing: they may only be framed by this origin (`X-Frame-Options` + `frame-ancestors 'self'`), so a third-party site cannot overlay
 *   the login page or an admin screen. Responses that set their own framing policy (the embeddable /embed and /c pages send
 *   `frame-ancestors <widget domains>`) are left untouched, together with everything else they send.
 * - Content-Security-Policy for every HTML page (`ContentSecurityPolicy`): a per-request nonce for the inline script, no inline handlers,
 *   same-origin assets. `chat.security.csp_mode` (`CSP_MODE`): `enforce` (the production default), `report-only` (the default elsewhere:
 *   violations are reported to `/csp-report` and the console, nothing is blocked) or `off` (framing only, as before P7).
 * - `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` (no camera, microphone, location, payment, USB ...),
 *   `Cross-Origin-Opener-Policy: same-origin` (no window the dashboard opens can reach back through `window.opener`),
 *   `X-Permitted-Cross-Domain-Policies`, and HSTS only on a request that came in over https (the proxy's `X-Forwarded-Proto` counts once
 *   `TRUSTED_PROXIES` is set).
 *
 * The generated API documentation (`/docs`) needs inline scripts of its own and keeps the framing policy only.
 */
final class SecurityHeaders
{
    public const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), display-capture=(), xr-spatial-tracking=()';

    /** Pages that keep the framing policy only (their own markup is not ours to nonce). */
    private const RELAXED_PATHS = ['docs', 'docs/*'];

    public function __construct(private readonly ContentSecurityPolicy $policy) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        // Before the view renders: every tag `@vite` / `@fonts` / `@viteReactRefresh` prints (and the template's own `nonce=` attribute) uses it.
        $nonce = Vite::useCspNonce();

        $response = $next($request);
        $headers = $response->headers;

        $csp = (string) $headers->get('Content-Security-Policy', '');
        $setsOwnFraming = str_contains($csp, 'frame-ancestors') || $headers->has('X-Frame-Options');

        if (! $setsOwnFraming) {
            $headers->set('X-Frame-Options', 'SAMEORIGIN');
            $headers->set('Content-Security-Policy', trim($csp === '' ? "frame-ancestors 'self'" : $csp."; frame-ancestors 'self'"));
            $this->applyContentSecurityPolicy($request, $response, $nonce);
            $this->setIfMissing($headers, 'Cross-Origin-Opener-Policy', 'same-origin');
            $this->setIfMissing($headers, 'Permissions-Policy', self::PERMISSIONS_POLICY);
            $this->setIfMissing($headers, 'X-Permitted-Cross-Domain-Policies', 'none');
        }

        $this->setIfMissing($headers, 'X-Content-Type-Options', 'nosniff');
        $this->setIfMissing($headers, 'Referrer-Policy', 'strict-origin-when-cross-origin');

        $strictTransport = self::strictTransportSecurity($request);

        if ($strictTransport !== null) {
            $this->setIfMissing($headers, 'Strict-Transport-Security', $strictTransport);
        }

        return $response;
    }

    /** The value of `Strict-Transport-Security` for this request, or null when it must not be sent (plain http, or switched off). */
    public static function strictTransportSecurity(Request $request): ?string
    {
        $maxAge = (int) config('chat.security.hsts_max_age', 31_536_000);

        if ($maxAge <= 0 || ! $request->isSecure()) {
            return null;
        }

        return 'max-age='.$maxAge.(config('chat.security.hsts_include_subdomains') ? '; includeSubDomains' : '');
    }

    private function applyContentSecurityPolicy(Request $request, Response $response, string $nonce): void
    {
        $mode = (string) config('chat.security.csp_mode', 'enforce');

        if ($mode === 'off' || ! $this->isHtmlDocument($response) || $request->is(...self::RELAXED_PATHS)) {
            return;
        }

        $policy = $this->policy->build($request, $nonce);

        if ($mode === 'report-only') {
            // `frame-ancestors` is enforced by the header above (a report-only policy ignores it), the rest is only reported.
            $response->headers->set('Content-Security-Policy-Report-Only', $policy);

            return;
        }

        $response->headers->set('Content-Security-Policy', $policy);
    }

    /**
     * A body a browser will render: HTML, or a response whose type is not decided yet (an error page rendered by the exception handler has
     * none until it is sent, and then it is HTML). Redirects and empty answers (204) carry nothing to protect.
     */
    private function isHtmlDocument(Response $response): bool
    {
        if ($response->isRedirection() || $response->isEmpty()) {
            return false;
        }

        $type = strtolower((string) $response->headers->get('Content-Type', ''));

        return $type === '' || str_starts_with($type, 'text/html');
    }

    private function setIfMissing(ResponseHeaderBag $headers, string $name, string $value): void
    {
        if (! $headers->has($name)) {
            $headers->set($name, $value);
        }
    }
}
