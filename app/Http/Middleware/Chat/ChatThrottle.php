<?php

namespace App\Http\Middleware\Chat;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Symfony\Component\HttpFoundation\Response;

/**
 * Applies one of the named chat limiters (`public-session`, `public-message`, `public-upload`, `public-offline`, `staff-api`;
 * numbers in `config/chat.php`, defined in `ChatServiceProvider`): `ChatThrottle::class.':public-message'`.
 *
 * A class of our own instead of the `throttle:` alias because Laravel moves middleware on its priority list to the front of the
 * stack: the limiter would then run before the visitor / staff authentication and (on the session route) before the origin
 * check, which is exactly what these limiters are placed after. Over the limit: `429 rate_limited` with `Retry-After`.
 */
final class ChatThrottle
{
    public function __construct(private readonly ThrottleRequests $throttle) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next, string $limiter): Response
    {
        return $this->throttle->handle($request, $next, $limiter);
    }
}
