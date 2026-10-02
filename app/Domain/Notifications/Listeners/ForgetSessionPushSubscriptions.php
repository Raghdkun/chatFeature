<?php

namespace App\Domain\Notifications\Listeners;

use App\Models\PushSubscription;
use Illuminate\Auth\Events\Logout;
use Throwable;

/**
 * Signing out takes the browser's push subscription with it: the subscriptions the signed-out web session registered are deleted, so a
 * shared computer stops showing the previous person's chat requests (and, with previews on, the visitors' words). Browsers
 * subscribed from another session of the same user (their phone, a second browser) are untouched. The next sign-in on this browser
 * registers it again (the dashboard re-checks the registration on every load).
 *
 * Best effort: a failure here must never get in the way of signing out.
 */
final class ForgetSessionPushSubscriptions
{
    public function handle(Logout $event): void
    {
        try {
            $userId = $event->user->getAuthIdentifier();

            if (! app()->bound('session.store')) {
                return;
            }

            $sessionId = app('session.store')->getId();

            if ($sessionId === '') {
                return;
            }

            PushSubscription::query()
                ->ownedBy((int) $userId)
                ->where('session_hash', PushSubscription::hashSession($sessionId))
                ->delete();
        } catch (Throwable $exception) {
            report($exception);
        }
    }
}
