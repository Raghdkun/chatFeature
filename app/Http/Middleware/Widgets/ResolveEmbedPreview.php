<?php

namespace App\Http\Middleware\Widgets;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\SessionContext;
use App\Models\User;
use Closure;
use Illuminate\Cookie\Middleware\EncryptCookies;
use Illuminate\Http\Request;
use Illuminate\Pipeline\Pipeline;
use Illuminate\Session\Middleware\StartSession;
use Symfony\Component\HttpFoundation\Response;

/**
 * The embed page is public and cookie-free, except for the builder's preview (`?preview=1`): that mode is for signed-in
 * administrators only. When the flag is present AND the request carries a session cookie, the session stack is run just
 * long enough to read the user, then every cookie is stripped from the response again. The outcome is the `embed_preview`
 * request attribute: `true` for an active admin, `false` when the flag is absent, 403 for anyone else asking for it.
 */
final class ResolveEmbedPreview
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $request->attributes->set('embed_preview', false);

        if (! $request->boolean('preview')) {
            return $next($request);
        }

        if (! $request->cookies->has((string) config('session.cookie'))) {
            abort(403, __('The preview is only available to signed-in administrators.'));
        }

        $response = (new Pipeline(app()))
            ->send($request)
            ->through([EncryptCookies::class, StartSession::class])
            ->then(function (Request $request) use ($next): Response {
                $user = $request->user();

                abort_unless($user instanceof User && $user->is_admin && $user->is_active, 403, __('The preview is only available to signed-in administrators.'));
                // A session the auth portal revoked in the meantime (mode 2) must not keep the preview.
                abort_if(app(AuthDriver::class)->validateSession($user, SessionContext::fromRequest($request)) === SessionVerdict::Revoked, 403);

                $request->attributes->set('embed_preview', true);

                return $next($request);
            });

        foreach ($response->headers->getCookies() as $cookie) {
            $response->headers->removeCookie($cookie->getName(), $cookie->getPath(), $cookie->getDomain());
        }

        return $response;
    }
}
