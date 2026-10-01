<?php

namespace App\Http\Middleware;

use App\Models\User;
use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Admin-only routes (alias `admin`). Use after `auth` / `auth:sanctum`, `session.valid` and `chat.access`.
 * JSON callers get 403 {error:{code:'forbidden'}}, browser requests a 403 page.
 */
final class EnsureAdmin
{
    /**
     * @param  Closure(Request): Response  $next
     */
    public function handle(Request $request, Closure $next): Response
    {
        $user = $request->user();

        if (! $user instanceof User || ! $user->is_admin || ! $user->is_active) {
            if ($request->expectsJson()) {
                return response()->json(['error' => ['code' => 'forbidden', 'message' => __('Only administrators can do this.')]], 403);
            }

            abort(403, __('Only administrators can do this.'));
        }

        return $next($request);
    }
}
