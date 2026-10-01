<?php

namespace App\Http\Middleware;

use Illuminate\Foundation\Http\Middleware\PreventRequestForgery;

/**
 * The framework's CSRF check, except that the dashboard's background requests (`StartSessionReadOnlyForApi`) do not answer with an
 * `XSRF-TOKEN` cookie. The cookie is the token of the session the request loaded: for a valid session it is the one the browser
 * already has, for a session that no longer exists (ended while the request was in flight) it is a throwaway token that would replace
 * the good cookie of the sign-in page the browser has opened meanwhile. Page responses keep setting it, and `GET /sanctum/csrf-cookie`
 * is a page route, so a client that needs a fresh token still has a place to ask.
 *
 * Bound over `PreventRequestForgery` in `AppServiceProvider` (the `web` group) and named in `config/sanctum.php` (the stateful API
 * pipeline).
 */
class PreventRequestForgeryWithoutCookieForApi extends PreventRequestForgery
{
    protected function addCookieToResponse($request, $response)
    {
        if (StartSessionReadOnlyForApi::isReadOnly($request)) {
            return $response;
        }

        return parent::addCookieToResponse($request, $response);
    }
}
