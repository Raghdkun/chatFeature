<?php

namespace App\Http\Middleware\Auth;

use App\Http\Exceptions\ApiProblemException;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A credential is a few hundred bytes: a sign-in body over `staff_auth.max_body_bytes` (8 KiB) is refused with `413 payload_too_large` before it
 * is parsed or hashed. The declared `Content-Length` is checked first (nothing is read); a body without one (chunked) is measured once read.
 */
final class LimitRequestBodySize
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $limit = max(256, (int) config('staff_auth.max_body_bytes', 8192));
        $declared = $request->headers->get('Content-Length');

        if (($declared !== null && ctype_digit($declared) && (int) $declared > $limit) || ($declared === null && strlen($request->getContent()) > $limit)) {
            throw new ApiProblemException(413, 'payload_too_large', __('The request body is too large.'));
        }

        return $next($request);
    }
}
