<?php

namespace App\Domain\Presence\Listeners;

use App\Domain\Presence\PresenceService;
use App\Models\User;
use Illuminate\Auth\Events\Logout;
use Throwable;

/**
 * Signing out takes the agent offline at once. Without this the presence record outlived the session by its whole window (90 s), so
 * routing and the widgets' availability still counted somebody who had left and a visitor could wait on nobody.
 *
 * Only the person's own "Log out" counts: the same event also fires when an OLD session is turned away (a password was changed
 * elsewhere, the account was revoked), and that must not switch off a colleague-visible status of someone who is working in another
 * session. Best effort: it never gets in the way of signing out.
 */
final class GoOfflineOnSignOut
{
    public function __construct(private readonly PresenceService $presence) {}

    public function handle(Logout $event): void
    {
        if (! $event->user instanceof User || ! request()->routeIs('logout')) {
            return;
        }

        try {
            $this->presence->signedOut($event->user);
        } catch (Throwable $exception) {
            report($exception);
        }
    }
}
