<?php

namespace App\Http\Middleware\Widgets;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Symfony\Component\HttpFoundation\Response;

/**
 * The per-widget limits (`public-config-widget`), placed AFTER AuthorizeWidgetOrigin so only requests that passed the
 * origin check count: a flood from a disallowed origin (or at an unknown key) cannot use up the budget of the
 * visitors the widget is meant for. A `429` raised here travels back through AuthorizeWidgetOrigin and so carries
 * the CORS headers of the allowed origin. (A class of our own instead of the `throttle:` alias for the reason given in
 * ThrottlePublicNetwork.)
 */
final class ThrottlePublicWidget
{
    public const LIMITER = 'public-config-widget';

    public function __construct(private readonly ThrottleRequests $throttle) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        return $this->throttle->handle($request, $next, self::LIMITER);
    }
}
