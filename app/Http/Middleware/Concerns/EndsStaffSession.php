<?php

namespace App\Http\Middleware\Concerns;

use App\Auth\Contracts\AuthDriver;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Symfony\Component\HttpFoundation\Response;

trait EndsStaffSession
{
    /**
     * Sign the user out and tell them why: JSON clients get an error body, browsers a redirect to
     * the login page with a toast (Inertia flash) and the shared `flash.error` message.
     */
    protected function endSession(Request $request, string $code, string $message, int $jsonStatus): Response
    {
        app(AuthDriver::class)->logout($request);

        if ($request->expectsJson()) {
            return response()->json(['error' => ['code' => $code, 'message' => $message]], $jsonStatus);
        }

        Inertia::flash('toast', ['type' => 'error', 'message' => $message]);

        return redirect()->route('login')->with('error', $message);
    }
}
