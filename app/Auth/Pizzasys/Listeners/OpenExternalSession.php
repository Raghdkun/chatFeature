<?php

namespace App\Auth\Pizzasys\Listeners;

use App\Auth\Pizzasys\ExternalSessionStore;
use App\Auth\Pizzasys\PendingPortalLogins;
use App\Auth\Support\SessionContext;
use App\Models\User;
use Illuminate\Auth\Events\Login;
use Illuminate\Http\Request;

/**
 * The Fortify pipeline logs a user in after `PizzasysDriver::attempt()` accepted them. Right then the portal session
 * is opened and its id stored in the browser session (session data survives the id regeneration that follows).
 * Logins that did not come from the driver (no pending hand-over) are left alone.
 */
final class OpenExternalSession
{
    public function __construct(
        private readonly ExternalSessionStore $sessions,
        private readonly Request $request,
    ) {}

    public function handle(Login $event): void
    {
        if (! $event->user instanceof User) {
            return;
        }

        $pending = app(PendingPortalLogins::class)->pull($event->user->getKey());

        if ($pending === null) {
            return;
        }

        $sessionId = $this->request->hasSession() ? $this->request->session()->getId() : null;
        $session = $this->sessions->open($pending, $this->request, null, $sessionId);

        if ($this->request->hasSession()) {
            $this->request->session()->put(SessionContext::EXTERNAL_SESSION_KEY, $session->getKey());
        }
    }
}
