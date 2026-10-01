<?php

namespace App\Http\Middleware;

use App\Domain\Install\InstallState;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * The dashboard calls the management API with the session cookie, which Sanctum only honours for "stateful"
 * hosts. Besides the APP_URL env default, trust the host of the `app.url` the wizard saved (the two can differ),
 * so a correct install never answers 401 to its own dashboard. Runs per API request (never at boot, so artisan
 * commands that run before the database exists are unaffected) and must precede Sanctum's stateful middleware.
 */
final class TrustInstalledAppHost
{
    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        if ($this->state->isInstalled()) {
            $url = settings()->string('app.url', '');
            $host = parse_url($url, PHP_URL_HOST);
            $port = parse_url($url, PHP_URL_PORT);

            if (is_string($host) && $host !== '') {
                $entry = is_int($port) ? $host.':'.$port : $host;
                $stateful = (array) config('sanctum.stateful', []);

                if (! in_array($entry, $stateful, true)) {
                    config(['sanctum.stateful' => [...$stateful, $entry]]);
                }
            }
        }

        return $next($request);
    }
}
