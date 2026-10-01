<?php

namespace App\Http\Middleware\Widgets;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Symfony\Component\HttpFoundation\Response;

/**
 * The per-client-network limit (`public-config`), independent of the widget key and applied before the key is looked up.
 *
 * A class of our own instead of the `throttle:` alias: Laravel re-sorts middleware that are on its priority list
 * (`throttle`, `SubstituteBindings`) to the front of the stack, which would put this limiter in front of
 * ShieldPublicWidgets and ahead of its CORS handling of `429` responses.
 */
final class ThrottlePublicNetwork
{
    public const LIMITER = 'public-config';

    public function __construct(private readonly ThrottleRequests $throttle) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        return $this->throttle->handle($request, $next, self::LIMITER);
    }
}
