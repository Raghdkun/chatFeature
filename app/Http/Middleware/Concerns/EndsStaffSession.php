<?php

namespace App\Http\Middleware\Concerns;

use App\Auth\Contracts\AuthDriver;
use App\Http\Middleware\StartSessionReadOnlyForApi;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Symfony\Component\HttpFoundation\Response;

trait EndsStaffSession
{
    /**
     * Sign the user out and tell them why: JSON clients get an error body, browsers a redirect to
     * the login page with a toast (Inertia flash), the shared `flash.error` message and the `reason` code.
     *
     * A background request of the dashboard (`StartSessionReadOnlyForApi`: `api/*`, `POST /broadcasting/auth`) is only turned away
     * with the JSON error: it cannot save the session, so ending it here would only destroy the stored one and the notice with it.
     * The dashboard follows a 401 with a page request, and that request ends the session and flashes the notice.
     */
    protected function endSession(Request $request, string $code, string $message, int $jsonStatus): Response
    {
        $readOnly = StartSessionReadOnlyForApi::isReadOnly($request);

        if (! $readOnly) {
            app(AuthDriver::class)->logout($request);
        }

        if ($readOnly || $request->expectsJson()) {
            return response()->json(['error' => ['code' => $code, 'message' => $message]], $jsonStatus);
        }

        Inertia::flash('toast', ['type' => 'error', 'message' => $message]);

        return redirect()->route('login')->with('error', $message)->with('reason', $code);
    }
}
