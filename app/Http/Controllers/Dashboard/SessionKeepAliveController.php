<?php

namespace App\Http\Controllers\Dashboard;

use App\Http\Controllers\Controller;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * `GET /session/keepalive`: the one background request that keeps a dashboard session alive.
 *
 * The management API never writes the session (`StartSessionReadOnlyForApi`), so an agent who leaves the inbox open all shift, on the
 * websocket and the REST polls alone, would otherwise be signed out when the session lifetime runs out. The dashboard calls this
 * page route every 20 minutes (and when a tab that was hidden for a while comes back): the session is saved, which extends the
 * lifetime, and the answer is empty. It is an ordinary web request in every other respect (`auth`, `session.valid`, `chat.access`),
 * so a revoked or demoted account is turned away like on any page.
 *
 * It must not change what the next real page request finds: pending flash data is carried over (it is not that page), and the stored
 * "previous URL" is left alone (`StartSessionReadOnlyForApi::storeCurrentUrl`).
 */
class SessionKeepAliveController extends Controller
{
    public function __invoke(Request $request): Response
    {
        $request->session()->reflash();

        return response()->noContent(headers: ['Cache-Control' => 'no-store']);
    }
}
