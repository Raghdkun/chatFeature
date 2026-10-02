<?php

namespace App\Domain\Notifications\Listeners;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationMissed;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Notifications\Actions\DismissPushes;
use App\Domain\Notifications\Actions\PushOfferToAgents;
use App\Domain\Notifications\Actions\PushVisitorMessage;
use Closure;
use Illuminate\Events\Dispatcher;
use Throwable;

/**
 * Turns the chat's domain events into OS pushes (decisions P5-D4, P5-D5). Registered by `NotificationsServiceProvider`.
 *
 * Push is an add-on to the realtime layer, never a dependency of REST: every handler runs inside `guard()`, so whatever goes wrong
 * here (a cache or queue outage, a missing row) is reported and the request that caused the event carries on. The decisions are cheap
 * reads; the sending itself is a queued job (`SendPushToUser`).
 *
 *  - `ChatOffered`                     -> a push to offered agents who are away from the dashboard.
 *  - `MessageCreated` (visitor)        -> a push to the assigned agent, if away.
 *  - `ChatTaken` / `ConversationClaimed` / `ConversationClosed` (cancelled) / `ConversationMissed`
 *                                      -> a silent `dismiss` of `offer-{ulid}` for everyone who was pushed that offer.
 *  - `MessagesSeen` (agent) / `ConversationEnded` / `ConversationClosed` / `ConversationTransferred`
 *                                      -> a silent `dismiss` of `chat-{ulid}` for the agent who was pushed it.
 */
final class PushEventSubscriber
{
    public function __construct(
        private readonly PushOfferToAgents $offers,
        private readonly PushVisitorMessage $messages,
        private readonly DismissPushes $dismissals,
    ) {}

    /**
     * @return array<class-string, string>
     */
    public function subscribe(Dispatcher $events): array
    {
        return [
            ChatOffered::class => 'chatOffered',
            MessageCreated::class => 'messageCreated',
            ChatTaken::class => 'chatTaken',
            ConversationClaimed::class => 'conversationClaimed',
            ConversationMissed::class => 'conversationMissed',
            ConversationClosed::class => 'conversationClosed',
            ConversationEnded::class => 'conversationEnded',
            ConversationTransferred::class => 'conversationTransferred',
            MessagesSeen::class => 'messagesSeen',
        ];
    }

    public function chatOffered(ChatOffered $event): void
    {
        $this->guard(fn () => $this->offers->handle($event->conversation, $event->offers, $event->expiresAt));
    }

    public function messageCreated(MessageCreated $event): void
    {
        $this->guard(fn () => $this->messages->handle($event->message));
    }

    /** Somebody else won the chat: the losers' notifications go (the winner's own devices are closed by `conversationClaimed`). */
    public function chatTaken(ChatTaken $event): void
    {
        $this->guard(fn () => $this->dismissals->offers($event->conversation, array_values(array_filter($event->otherOfferedUserIds, fn (int $id): bool => $id !== $event->claimedBy->id))));
    }

    /** The winner accepted on one device: the offer notification on their other devices has nothing left to offer. */
    public function conversationClaimed(ConversationClaimed $event): void
    {
        $this->guard(fn () => $this->dismissals->offers($event->conversation, [$event->agent->id]));
    }

    public function conversationMissed(ConversationMissed $event): void
    {
        $this->guard(fn () => $this->dismissals->offers($event->conversation));
    }

    public function conversationClosed(ConversationClosed $event): void
    {
        $this->guard(function () use ($event): void {
            // Only a visitor who left the queue leaves open offers behind (the others were closed when the chat was claimed or expired).
            if ($event->reason === ConversationCloseReason::Cancelled) {
                $this->dismissals->offers($event->conversation);
            }

            $this->dismissals->chat($event->conversation, $event->conversation->assigned_agent_id);
        });
    }

    public function conversationEnded(ConversationEnded $event): void
    {
        $this->guard(fn () => $this->dismissals->chat($event->conversation, $event->conversation->assigned_agent_id));
    }

    /** The agent the chat was taken from no longer needs its message notification. */
    public function conversationTransferred(ConversationTransferred $event): void
    {
        $this->guard(fn () => $this->dismissals->chat($event->conversation, $event->fromAgent?->id));
    }

    /** The agent read the chat (on any device): the "new message" notification is stale everywhere. */
    public function messagesSeen(MessagesSeen $event): void
    {
        if ($event->by !== SenderType::Agent) {
            return;
        }

        $this->guard(fn () => $this->dismissals->chat($event->conversation, $event->conversation->assigned_agent_id));
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
