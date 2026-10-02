<?php

namespace App\Domain\Chat\Realtime\Sockets;

use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Visitors\Events\VisitorSessionsEnded;
use App\Models\User;
use Closure;
use Illuminate\Auth\Events\Logout;
use Illuminate\Events\Dispatcher;
use Throwable;

/**
 * The triggers of the stale-socket cut-off that are domain events (the Eloquent hooks on `User` live in `RealtimeServiceProvider`,
 * the natural expiry of a visitor token in `RealtimeSweep`). Registered next to `ChatEventSubscriber`, AFTER it: for
 * `StaffSessionRevoked` the `session.revoked` frame is published first, then the sockets are closed.
 *
 * Every handler is guarded: whatever fails is reported and the request that raised the event carries on. The services are resolved when an
 * event arrives, not when the subscriber is registered at boot (the terminator behind them is a binding that tests swap).
 */
final class SocketCutOffSubscriber
{
    /**
     * @return array<class-string, string>
     */
    public function subscribe(Dispatcher $events): array
    {
        return [
            StaffSessionRevoked::class => 'staffSessionRevoked',
            ConversationQueued::class => 'conversationAccessChanged',
            ConversationClaimed::class => 'conversationAccessChanged',
            ConversationAssigned::class => 'conversationAccessChanged',
            ConversationTransferred::class => 'conversationAccessChanged',
            VisitorSessionsEnded::class => 'visitorSessionsEnded',
            Logout::class => 'loggedOut',
        ];
    }

    public function staffSessionRevoked(StaffSessionRevoked $event): void
    {
        $this->guard(fn () => app(SocketCutOff::class)->cutStaff($event->userId, 'session_revoked:'.$event->reason->value));
    }

    public function conversationAccessChanged(ConversationQueued|ConversationClaimed|ConversationAssigned|ConversationTransferred $event): void
    {
        $this->guard(fn () => app(ConversationGrants::class)->revalidate($event->conversation));
    }

    public function visitorSessionsEnded(VisitorSessionsEnded $event): void
    {
        $this->guard(function () use ($event): void {
            foreach ($event->sessionIds as $sessionId) {
                app(SocketCutOff::class)->cutVisitorSession($sessionId, $event->reason);
            }
        });
    }

    /** A signed-out staff member's open sockets (every tab and device: the others reconnect and authorise again). */
    public function loggedOut(Logout $event): void
    {
        $user = $event->user;

        if (! $user instanceof User || ! $user->hasChatAccess()) {
            return;
        }

        $this->guard(fn () => app(SocketCutOff::class)->cutStaff($user->id, 'logout'));
    }

    /**
     * @param  Closure(): mixed  $work
     */
    private function guard(Closure $work): void
    {
        try {
            $work();
        } catch (Throwable $exception) {
            report($exception);
        }
    }
}
