<?php

namespace App\Http\Middleware;

use App\Domain\Install\InstallState;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Applies the UI locale: the signed-in user's own locale, else the workspace setting `app.locale`,
 * else config('app.locale'). Unsupported values are ignored. Database-free before installation.
 */
final class SetLocale
{
    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $supported = (array) config('chat.locales', ['en']);
        $candidates = [];

        if ($this->state->isInstalled()) {
            $candidates[] = $request->user()?->locale;
            $candidates[] = settings('app.locale');
        }

        foreach ($candidates as $candidate) {
            if (is_string($candidate) && in_array($candidate, $supported, true)) {
                app()->setLocale($candidate);

                break;
            }
        }

        return $next($request);
    }
}
