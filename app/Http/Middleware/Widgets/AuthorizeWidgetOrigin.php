<?php

namespace App\Http\Middleware\Widgets;

use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\AppOrigin;
use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Gate of the public widget API (`/api/v1/public/widgets/{key}/...`):
 *
 * 1. unknown / deleted / disabled widget -> `404 widget_not_found`;
 * 2. a browser `Origin` must be one of the widget's domains (or this installation's own origin), else `403 origin_not_allowed`
 *    without any CORS header; an allowed origin is echoed back (`Access-Control-Allow-Origin`, `Vary: Origin`);
 * 3. a request without `Origin` (server-to-server, mobile) only passes when the widget allows non-browser clients, or when the
 *    browser itself says it is same-origin (`Sec-Fetch-Site: same-origin`, which scripts cannot forge);
 * 4. `OPTIONS` preflights are answered here (204) for allowed origins.
 *
 * The resolved widget is exposed as the `widget` request attribute and the normalised caller as `widget_origin`
 * (`scheme://host[:port]`, or `-` without an Origin header): what the per-widget rate limiter keys on. An allowed
 * origin is remembered briefly (WidgetCache) so a `429` from a limiter in front of this middleware can carry CORS
 * headers without a database lookup. A `429` coming back from a limiter behind it passes through `cors()` here.
 * Never sets cookies.
 */
final class AuthorizeWidgetOrigin
{
    /** Request headers a preflight may ask for. */
    private const ALLOWED_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'if-none-match', 'x-requested-with'];

    public function __construct(
        private readonly PublicWidgetFinder $widgets,
        private readonly OriginMatcher $origins,
        private readonly AppOrigin $appOrigin,
        private readonly WidgetCache $cache,
    ) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $widget = $this->widgets->find((string) $request->route('key'));

        if ($widget === null) {
            return $this->error(404, 'widget_not_found', __('This widget does not exist or is disabled.'));
        }

        $origin = $request->headers->get('Origin');
        $caller = '-';

        if ($origin !== null) {
            $parsed = $this->origins->parseOrigin($origin);

            if ($parsed === null || ! $this->isAllowedOrigin($origin, $widget)) {
                return $this->error(403, 'origin_not_allowed', __('This website is not allowed to use the widget.'));
            }

            $caller = $parsed['scheme'].'://'.$parsed['host'].($parsed['port'] !== null ? ':'.$parsed['port'] : '');
            $this->cache->rememberAllowedOrigin($widget->public_key, $caller);
        } elseif (! $widget->allow_non_browser_clients && $request->headers->get('Sec-Fetch-Site') !== 'same-origin') {
            return $this->error(403, 'origin_not_allowed', __('This website is not allowed to use the widget.'));
        }

        if ($request->isMethod('OPTIONS')) {
            return $this->preflight(response()->noContent(), $origin, $request->headers->get('Access-Control-Request-Headers'));
        }

        $request->attributes->set('widget', $widget);
        $request->attributes->set('widget_origin', $caller);

        return $this->cors($next($request), $origin);
    }

    private function isAllowedOrigin(string $origin, Widget $widget): bool
    {
        $domains = $widget->domains->map(fn (WidgetDomain $domain): string => $domain->host);

        return $this->origins->matches($origin, $domains)
            || ($this->origins->parseOrigin($origin) !== null && strtolower($origin) === $this->appOrigin->url());
    }

    private function cors(Response $response, ?string $origin): Response
    {
        return CorsHeaders::allow($response, $origin);
    }

    private function preflight(Response $response, ?string $origin, ?string $requestedHeaders): Response
    {
        $this->cors($response, $origin);
        $response->headers->set('Vary', 'Origin, Access-Control-Request-Headers');

        if ($origin === null) {
            return $response;
        }

        $requested = array_map(static fn (string $header): string => strtolower(trim($header)), explode(',', (string) $requestedHeaders));
        $allowed = array_values(array_intersect(self::ALLOWED_REQUEST_HEADERS, $requested));

        $response->headers->set('Access-Control-Allow-Methods', 'GET, OPTIONS');
        $response->headers->set('Access-Control-Allow-Headers', implode(', ', $allowed === [] ? ['accept', 'content-type'] : $allowed));
        $response->headers->set('Access-Control-Max-Age', '600');

        return $response;
    }

    private function error(int $status, string $code, string $message): Response
    {
        return response()->json(['error' => ['code' => $code, 'message' => $message]], $status, [
            'Vary' => 'Origin',
            'Cache-Control' => 'no-store',
        ]);
    }
}
