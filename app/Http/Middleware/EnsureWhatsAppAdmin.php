<?php

namespace App\Http\Middleware;

use App\Models\User;
use App\Models\WaChat;
use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Gate;
use Symfony\Component\HttpFoundation\Response;

/**
 * Every WhatsApp surface that is not a webhook (alias `wa.admin`, decision P6-D1): the management API, the inbox and settings pages.
 * Use after `auth` / `auth:sanctum`, `session.valid` and `chat.access`. It asks the `WhatsAppPolicy` (`viewAny`), so the policy is the
 * single place that says who may: an active administrator. Everyone else, a missing user included (a visitor token is no user), gets
 * `403 {error: {code: 'forbidden'}}` as JSON (API and `Accept: application/json` requests) or the normal 403 page; nothing says
 * that WhatsApp exists.
 */
final class EnsureWhatsAppAdmin
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (! $user instanceof User || ! Gate::forUser($user)->allows('viewAny', WaChat::class)) {
            if ($request->is('api/*') || $request->expectsJson()) {
                return response()->json(['error' => ['code' => 'forbidden', 'message' => __('Only administrators can do this.')]], 403);
            }

            abort(403, __('Only administrators can do this.'));
        }

        return $next($request);
    }
}
