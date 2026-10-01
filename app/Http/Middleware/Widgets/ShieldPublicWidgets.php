<?php

namespace App\Http\Middleware\Widgets;

use App\Domain\Widgets\Origin\OriginMatcher;
use App\Domain\Widgets\Support\ClientNetwork;
use App\Domain\Widgets\Support\WidgetCache;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Symfony\Component\HttpFoundation\Response;

/**
 * Outermost guard of the public widget endpoints (loader script, iframe pages, config/availability API):
 *
 * - counts lookups of widget keys that do not exist (any `404` it sees) per client network and answers `429` once a
 *   network probes too many (`chat.rate_limits.public_unknown_keys` per minute), so random keys cannot be used to
 *   hammer the database or enumerate widgets;
 * - makes a `429` from this or the inner limiters readable by the visitor's page: when the request came from an origin
 *   that was allowed to use this very widget a moment ago (WidgetCache::wasAllowedOrigin, no database access), the
 *   response carries the same CORS headers an allowed response would. Other origins never get them.
 */
final class ShieldPublicWidgets
{
    private const WINDOW_SECONDS = 60;

    public function __construct(
        private readonly OriginMatcher $origins,
        private readonly WidgetCache $cache,
    ) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $missKey = 'widgets:misses:'.ClientNetwork::bucket($request->ip());
        $maxMisses = (int) config('chat.rate_limits.public_unknown_keys', 60);

        if (RateLimiter::tooManyAttempts($missKey, $maxMisses)) {
            return $this->readableByAllowedOrigin($request, $this->tooManyRequests($request, RateLimiter::availableIn($missKey)));
        }

        $response = $next($request);

        if ($response->getStatusCode() === 404) {
            RateLimiter::hit($missKey, self::WINDOW_SECONDS);
        }

        return $this->readableByAllowedOrigin($request, $response);
    }

    private function readableByAllowedOrigin(Request $request, Response $response): Response
    {
        if ($response->getStatusCode() !== 429 || ! $request->is('api/*') || $response->headers->has('Access-Control-Allow-Origin')) {
            return $response;
        }

        $origin = $request->headers->get('Origin');
        $parsed = $this->origins->parseOrigin($origin);

        if ($origin === null || $parsed === null) {
            return $response;
        }

        $normalised = $parsed['scheme'].'://'.$parsed['host'].($parsed['port'] !== null ? ':'.$parsed['port'] : '');

        return $this->cache->wasAllowedOrigin((string) $request->route('key'), $normalised)
            ? CorsHeaders::allow($response, $origin)
            : $response;
    }

    private function tooManyRequests(Request $request, int $retryAfter): Response
    {
        $headers = ['Retry-After' => (string) max(1, $retryAfter), 'Cache-Control' => 'no-store'];

        if ($request->is('api/*')) {
            return response()->json(['error' => ['code' => 'rate_limited', 'message' => __('Too many requests.')]], 429, $headers);
        }

        return response('Too many requests.', 429, $headers + ['Content-Type' => 'text/plain; charset=utf-8', 'X-Content-Type-Options' => 'nosniff']);
    }
}
