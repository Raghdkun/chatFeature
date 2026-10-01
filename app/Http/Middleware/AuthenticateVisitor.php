<?php

namespace App\Http\Middleware;

use App\Domain\Visitors\VisitorTokenService;
use App\Http\Exceptions\ApiProblemException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Authenticates a visitor of the public chat API by `Authorization: Bearer vt_...` (alias `visitor`, after the `widget` group).
 *
 * - no / malformed / unknown token: `401 unauthenticated`;
 * - a token whose session was revoked or has expired: `401 session_revoked` (the panel then starts a fresh session).
 *
 * On success the request carries the attributes `visitor_session` (VisitorSession) and `visitor` (Visitor); read them with
 * `$request->attributes->get(...)`. Visitors have no user: `$request->user()` stays null. Every ulid in the URL must still be
 * checked against the session (`VisitorSession::owns()`; answer `404`, never `403`).
 */
final class AuthenticateVisitor
{
    public function __construct(private readonly VisitorTokenService $tokens) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $token = $request->bearerToken();
        $session = $token === null ? null : $this->tokens->find($token);

        if ($session === null) {
            throw ApiProblemException::unauthorized('unauthenticated', __('Authentication is required.'));
        }

        if (! $session->isActive()) {
            throw ApiProblemException::unauthorized('session_revoked', __('This chat session has ended. Please start a new one.'));
        }

        $this->tokens->touch($session);

        $request->attributes->set('visitor_session', $session);
        $request->attributes->set('visitor', $session->visitor);

        return $next($request);
    }
}
