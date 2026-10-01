<?php

namespace App\Auth\Pizzasys\Listeners;

use App\Auth\Pizzasys\ExternalSessionStore;
use App\Auth\Support\SessionContext;
use App\Models\ExternalSession;
use App\Models\User;
use Illuminate\Auth\Events\Logout;
use Illuminate\Http\Request;

/**
 * Whenever the guard logs a portal user out (Fortify's own logout route included) the portal session ends with it:
 * revoked here, and the upstream token of THAT session is logged out best effort (never `refresh-token`, never
 * other tokens of the same person).
 */
final class CloseExternalSession
{
    public function __construct(
        private readonly ExternalSessionStore $sessions,
        private readonly Request $request,
    ) {}

    public function handle(Logout $event): void
    {
        if (! $event->user instanceof User || ! $this->request->hasSession()) {
            return;
        }

        $id = $this->request->session()->get(SessionContext::EXTERNAL_SESSION_KEY);

        if (! is_string($id) || $id === '') {
            return;
        }

        $session = ExternalSession::query()->with('environment')->whereKey($id)->where('user_id', $event->user->getKey())->first();

        if ($session !== null) {
            $this->sessions->revoke($session, 'logout', upstreamLogout: true);
        }

        $this->request->session()->forget(SessionContext::EXTERNAL_SESSION_KEY);
    }
}
