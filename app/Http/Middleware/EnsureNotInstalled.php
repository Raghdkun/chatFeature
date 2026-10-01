<?php

namespace App\Http\Middleware;

use App\Domain\Install\InstallState;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/** Route middleware for the wizard: once installed, every `/setup*` URL is 404. */
final class EnsureNotInstalled
{
    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if ($this->state->isInstalled()) {
            // JSON callers (the wizard's run endpoint) get an explicit marker so they can tell
            // "already installed" apart from any other 404 (wrong base path, proxy, unknown step).
            abort_if(! $request->expectsJson(), 404);

            return response()->json(['status' => 'installed'], 404);
        }

        return $next($request);
    }
}
