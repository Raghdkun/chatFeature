<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession;

/**
 * Laravel's `StartSession`, except that the dashboard's background requests only READ the session.
 *
 * The staff dashboard polls the management API (`api/*`: presence, queue, conversation lists, messages) and authorises its websocket
 * channels (`POST /broadcasting/auth`) with the session cookie, all the time and right after every page load. The stock middleware
 * saves the whole session at the end of every one of those requests (file / database driver: the last writer wins), ages the flash
 * data and sends the session cookie again. A request that was already running when a page request stored something therefore
 * wrote the old payload back over it: the URL a password confirmation returns to, a flash message, the "your session has ended"
 * notice were lost, and a response that arrived late re-sent an old cookie.
 *
 * These requests still LOAD the session (they need it to authenticate and for the CSRF token) but never save it, never age
 * flash data, never store the previous URL and never set a cookie. They cannot end the session either (`EndsStaffSession`): the page
 * request that follows does, with its notice. Every other request, the Fortify and Inertia pages included, runs the original code.
 *
 * Bound over `Illuminate\Session\Middleware\StartSession` in `AppServiceProvider`, so the `web` group and Sanctum's stateful
 * pipeline both get it. The public widget API (`widget` group) has no sessions at all.
 */
class StartSessionReadOnlyForApi extends StartSession
{
    /** Request attribute set while the session is read-only. */
    public const READ_ONLY_ATTRIBUTE = 'session.read_only';

    /** Paths whose requests never write the session. */
    private const READ_ONLY_PATHS = ['api/*', 'broadcasting/auth'];

    protected function handleStatefulRequest(Request $request, $session, Closure $next)
    {
        if (! $request->is(...self::READ_ONLY_PATHS)) {
            return parent::handleStatefulRequest($request, $session, $next);
        }

        $request->attributes->set(self::READ_ONLY_ATTRIBUTE, true);
        $request->setLaravelSession($this->startSession($request, $session));

        return $next($request);
    }

    /**
     * The keep-alive page request (`GET /session/keepalive`) saves the session like any page but is not a page the visitor navigated
     * to: it must not become the "previous URL" that redirects back to.
     */
    protected function storeCurrentUrl(Request $request, $session)
    {
        if ($request->routeIs('session.keepalive')) {
            return;
        }

        parent::storeCurrentUrl($request, $session);
    }

    /** Whether the session of this request is read-only (it was started by this middleware for a background request). */
    public static function isReadOnly(Request $request): bool
    {
        return $request->attributes->get(self::READ_ONLY_ATTRIBUTE) === true;
    }
}
