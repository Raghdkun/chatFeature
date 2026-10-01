<?php

namespace App\Http\Middleware;

use App\Domain\Install\InstallState;
use App\Http\Middleware\Concerns\EndsStaffSession;
use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * A signed-in user who is neither admin nor agent cannot use the dashboard: they are signed out
 * with a clear message (403 for JSON clients). Registered in the `web` group and as the
 * `chat.access` alias for API groups.
 */
final class EnsureChatAccess
{
    use EndsStaffSession;

    public function __construct(private readonly InstallState $state) {}

    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $this->state->isInstalled() ? $request->user() : null;

        if ($user instanceof User && ! $user->hasChatAccess() && ! $request->routeIs('logout')) {
            return $this->endSession(
                $request,
                'no_chat_access',
                __('This account has no access to the chat dashboard. Ask an administrator to grant it.'),
                403,
            );
        }

        return $next($request);
    }
}
