<?php

namespace App\Http\Middleware;

use App\Domain\Install\SetupTokenManager;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Wizard actions need the one-time setup token to have been verified in this browser session (skipped only for
 * APP_ENV=local requests that come straight from a loopback address).
 */
final class EnsureSetupTokenVerified
{
    public function __construct(private readonly SetupTokenManager $token) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if ($this->token->isVerified($request->session(), $request)) {
            return $next($request);
        }

        if ($request->expectsJson()) {
            return response()->json([
                'status' => 'failed',
                'message' => __('Enter the setup token first.'),
            ], 403);
        }

        return redirect()->route('setup.index');
    }
}
