<?php

namespace App\Support\ApiDocs;

use App\Http\Middleware\AuthenticateVisitor;
use App\Http\Middleware\Chat\ChatThrottle;
use App\Http\Middleware\Widgets\ThrottlePublicNetwork;
use App\Http\Middleware\Widgets\ThrottlePublicWidget;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\Route as RouteFacade;

/**
 * The routes the API reference is about, and what their middleware says about who may call them. Everything the generated
 * documentation states about authentication, access level and rate limits is read from here, so it cannot drift from the routes.
 */
final class ApiRoutes
{
    /**
     * Every route the rot guard demands documentation for: all of `api/v1/*` and the inbound `webhooks/*`.
     *
     * @return list<Route>
     */
    public static function required(): array
    {
        return array_values(array_filter(
            RouteFacade::getRoutes()->getRoutes(),
            static fn (Route $route): bool => str_starts_with($route->uri(), 'api/v1/') || str_starts_with($route->uri(), 'webhooks/'),
        ));
    }

    /**
     * Everything one reference covers (the required routes of its audience, plus the delivery routes of the public one).
     *
     * @return list<Route>
     */
    public static function forAudience(ApiAudience $audience): array
    {
        return array_values(array_filter(
            RouteFacade::getRoutes()->getRoutes(),
            static fn (Route $route): bool => ApiAudience::forUri($route->uri(), $route->getName()) === $audience,
        ));
    }

    /** The HTTP method an OpenAPI operation is filed under (the first one that is not `HEAD` / `OPTIONS`). */
    public static function method(Route $route): string
    {
        foreach ($route->methods() as $method) {
            if (! in_array($method, ['HEAD', 'OPTIONS'], true)) {
                return $method;
            }
        }

        return $route->methods()[0];
    }

    /** The path as OpenAPI spells it: `/api/v1/conversations/{conversation}`. */
    public static function path(Route $route): string
    {
        return '/'.ltrim(str_replace('?}', '}', $route->uri()), '/');
    }

    /** `GET /api/v1/conversations/{conversation}`: how the allow-lists and messages name a route. */
    public static function label(Route $route): string
    {
        return self::method($route).' '.self::path($route);
    }

    /**
     * The middleware as written on the route (aliases and class names, with their parameters).
     *
     * @return list<string>
     */
    public static function middleware(Route $route): array
    {
        return array_values(array_filter($route->gatherMiddleware(), is_string(...)));
    }

    public static function hasMiddleware(Route $route, string $name): bool
    {
        foreach (self::middleware($route) as $middleware) {
            if ($middleware === $name || str_starts_with($middleware, $name.':')) {
                return true;
            }
        }

        return false;
    }

    /** Whether the route carries a credential the caller must present: a Sanctum token / session, or a visitor token. */
    public static function isAuthenticated(Route $route): bool
    {
        return self::hasMiddleware($route, 'auth') || self::hasMiddleware($route, 'visitor') || self::hasMiddleware($route, AuthenticateVisitor::class);
    }

    public static function isVisitorRoute(Route $route): bool
    {
        return self::hasMiddleware($route, 'visitor') || self::hasMiddleware($route, AuthenticateVisitor::class);
    }

    /** `admin` or `wa.admin`: only active administrators get past the route middleware. */
    public static function isAdminOnly(Route $route): bool
    {
        return self::hasMiddleware($route, 'admin') || self::hasMiddleware($route, 'wa.admin');
    }

    /**
     * The named rate limiters in front of the route, in the order they run.
     *
     * @return list<string>
     */
    public static function limiters(Route $route): array
    {
        $limiters = [];

        foreach (self::middleware($route) as $middleware) {
            if (preg_match('/^(?:'.preg_quote(ChatThrottle::class, '/').'|throttle|'.preg_quote(ThrottleRequests::class, '/').'):(.+)$/', $middleware, $matches) === 1) {
                $limiters[] = $matches[1];
            } elseif ($middleware === ThrottlePublicNetwork::class) {
                $limiters[] = ThrottlePublicNetwork::LIMITER;
            } elseif ($middleware === ThrottlePublicWidget::class) {
                $limiters[] = ThrottlePublicWidget::LIMITER;
            }
        }

        return $limiters;
    }

    /**
     * The `{parameter}` names of the URI.
     *
     * @return list<string>
     */
    public static function parameters(Route $route): array
    {
        preg_match_all('/\{(\w+)\??\}/', $route->uri(), $matches);

        return $matches[1];
    }
}
