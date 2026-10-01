<?php

namespace App\Domain\Chat\Realtime\Listeners;

use App\Data\Chat\AgentRefData;
use App\Data\Chat\Events\ChatAssignedPayload;
use App\Data\Chat\Events\ChatClaimedPayload;
use App\Data\Chat\Events\ChatTakenPayload;
use App\Data\Chat\Events\ConversationClosedPayload;
use App\Data\Chat\Events\ConversationEndedPayload;
use App\Data\Chat\Events\ConversationRatedPayload;
use App\Data\Chat\Events\ConversationTransferredPayload;
use App\Data\Chat\Events\MessageCreatedPayload;
use App\Data\Chat\Events\MessageSeenPayload;
use App\Data\Chat\Events\PresenceChangedPayload;
use App\Data\Chat\Events\SessionRevokedPayload;
use App\Data\Chat\MessageData;
use App\Data\Chat\StaffAgentRefData;
use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\ConversationUpdated;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\MessagesSeen;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Chat\Events\StaffSessionRevoked;
use App\Domain\Chat\Events\UnseenCountChanged;
use App\Domain\Chat\Realtime\Broadcasts\ChatOfferedBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\ConversationUpdatedBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\ImmediatePayloadBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\OfflineTicketCreatedBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\PayloadBroadcast;
use App\Domain\Chat\Realtime\Broadcasts\UnreadUpdatedBroadcast;
use App\Domain\Chat\Realtime\Jobs\BroadcastQueueCounts;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\ConversationOffer;
use Closure;
use Illuminate\Events\Dispatcher;
use Throwable;

/**
 * Turns the spine's domain events (`App\Domain\Chat\Events`, dispatched by the Chat actions after their transaction committed) into
 * the broadcasts of docs/contracts/realtime-events.md. Registered by `RealtimeServiceProvider`.
 *
 * Realtime is an add-on to REST, never a dependency of it: every handler runs inside `guard()`, so whatever goes wrong here
 * (a payload that cannot be built, the queue or Reverb being down) is reported and the request that caused the event carries
 * on. The broadcasts themselves are `ShouldRescue`, which covers the publish step.
 *
 * Delivery: `message.created`, `chat.claimed` and `session.revoked` are published immediately (`ImmediatePayloadBroadcast`); the
 * rest is queued. Events that describe the current state of a conversation (`conversation.updated`, `chat.offered`, `unread.updated`,
 * `offline-ticket.created`, `queue.updated`) read it when the worker handles them.
 */
final class ChatEventSubscriber
{
    /**
     * @return array<class-string, string>
     */
    public function subscribe(Dispatcher $events): array
    {
        return [
            ConversationQueued::class => 'conversationQueued',
            ChatOffered::class => 'chatOffered',
            ChatTaken::class => 'chatTaken',
            ConversationClaimed::class => 'conversationClaimed',
            ConversationAssigned::class => 'conversationAssigned',
            ConversationUpdated::class => 'conversationUpdated',
            MessageCreated::class => 'messageCreated',
            MessagesSeen::class => 'messagesSeen',
            ConversationEnded::class => 'conversationEnded',
            ConversationClosed::class => 'conversationClosed',
            ConversationTransferred::class => 'conversationTransferred',
            OfflineTicketCreated::class => 'offlineTicketCreated',
            ConversationRated::class => 'conversationRated',
            UnseenCountChanged::class => 'unseenCountChanged',
            QueueChanged::class => 'queueChanged',
            PresenceChanged::class => 'presenceChanged',
            StaffSessionRevoked::class => 'staffSessionRevoked',
        ];
    }

    public function conversationQueued(ConversationQueued $event): void
    {
        $this->guard(function () use ($event): void {
            event(new ConversationUpdatedBroadcast($event->conversation->ulid));
            BroadcastQueueCounts::dispatch();
        });
    }

    public function chatOffered(ChatOffered $event): void
    {
        $this->guard(function () use ($event): void {
            $userIds = array_values(array_unique($event->offers->map(fn (ConversationOffer $offer): int => $offer->user_id)->all()));

            if ($userIds !== []) {
                event(new ChatOfferedBroadcast($event->conversation->ulid, $userIds, $event->wave, $event->expiresAt->getTimestamp()));
            }
        });
    }

    public function chatTaken(ChatTaken $event): void
    {
        $this->guard(function () use ($event): void {
            $losers = array_values(array_unique(array_filter($event->otherOfferedUserIds, fn (int $userId): bool => $userId !== $event->claimedBy->id)));

            if ($losers === []) {
                return;
            }

            $payload = new ChatTakenPayload($event->conversation->ulid, StaffAgentRefData::fromModel($event->claimedBy));

            event(new PayloadBroadcast(RealtimeEvent::ChatTaken, RealtimeChannels::staffMany($losers), $payload->toArray()));
        });
    }

    public function conversationClaimed(ConversationClaimed $event): void
    {
        $this->guard(function () use ($event): void {
            $conversation = $event->conversation;
            // The claim is a guarded UPDATE: the model the action passes on may predate it.
            $claimedAt = $conversation->claimed_at ?? $conversation->fresh()->claimed_at ?? now();
            $payload = new ChatClaimedPayload(AgentRefData::fromModel($event->agent), (string) Timestamps::iso($claimedAt));

            event(new ImmediatePayloadBroadcast(RealtimeEvent::ChatClaimed, [RealtimeChannels::conversation($conversation->ulid)], $payload->toArray()));
            event(new ConversationUpdatedBroadcast($conversation->ulid, [$event->agent->id]));
        });
    }

    public function conversationAssigned(ConversationAssigned $event): void
    {
        $this->guard(function () use ($event): void {
            $ulid = $event->conversation->ulid;

            event(new PayloadBroadcast(RealtimeEvent::ChatAssigned, [RealtimeChannels::staff($event->agent->id)], (new ChatAssignedPayload($ulid))->toArray()));
            event(new ConversationUpdatedBroadcast($ulid, array_values(array_filter([$event->agent->id, $event->previousAgent?->id]))));
        });
    }

    public function conversationUpdated(ConversationUpdated $event): void
    {
        $this->guard(fn () => event(new ConversationUpdatedBroadcast($event->conversation->ulid)));
    }

    /** The shared channel always gets the visitor-safe message: staff-only fields reach staff over REST. */
    public function messageCreated(MessageCreated $event): void
    {
        $this->guard(function () use ($event): void {
            $message = $event->message->loadMissing(['conversation.visitor', 'senderUser', 'attachments']);
            $payload = new MessageCreatedPayload(MessageData::fromModel($message));

            event(new ImmediatePayloadBroadcast(RealtimeEvent::MessageCreated, [RealtimeChannels::conversation($message->conversation->ulid)], $payload->toArray()));
        });
    }

    public function messagesSeen(MessagesSeen $event): void
    {
        $this->guard(function () use ($event): void {
            if ($event->by === SenderType::System) {
                return;
            }

            $payload = new MessageSeenPayload($event->upToSeq, $event->by, (string) Timestamps::iso(now()));

            event(new PayloadBroadcast(RealtimeEvent::MessageSeen, [RealtimeChannels::conversation($event->conversation->ulid)], $payload->toArray()));
        });
    }

    public function conversationEnded(ConversationEnded $event): void
    {
        $this->guard(function () use ($event): void {
            $conversation = $event->conversation;
            $ratingRequested = $conversation->rating_requested || (bool) $conversation->fresh()?->rating_requested;
            $payload = new ConversationEndedPayload($event->endedBy, $ratingRequested);

            event(new PayloadBroadcast(RealtimeEvent::ConversationEnded, [RealtimeChannels::conversation($conversation->ulid)], $payload->toArray()));
            event(new ConversationUpdatedBroadcast($conversation->ulid));
        });
    }

    public function conversationClosed(ConversationClosed $event): void
    {
        $this->guard(function () use ($event): void {
            $ulid = $event->conversation->ulid;

            event(new PayloadBroadcast(RealtimeEvent::ConversationClosed, [RealtimeChannels::conversation($ulid)], (new ConversationClosedPayload($event->reason))->toArray()));
            event(new ConversationUpdatedBroadcast($ulid));
        });
    }

    /** The visitor hears "connecting you to another agent"; the agent the chat was taken from gets a list refresh. */
    public function conversationTransferred(ConversationTransferred $event): void
    {
        $this->guard(function () use ($event): void {
            $ulid = $event->conversation->ulid;

            event(new PayloadBroadcast(RealtimeEvent::ConversationTransferred, [RealtimeChannels::conversation($ulid)], (new ConversationTransferredPayload)->toArray()));
            event(new ConversationUpdatedBroadcast($ulid, $event->fromAgent === null ? [] : [$event->fromAgent->id]));
        });
    }

    /** Admins get `offline-ticket.created`; agents who serve the category get the same ticket as a list refresh. */
    public function offlineTicketCreated(OfflineTicketCreated $event): void
    {
        $this->guard(function () use ($event): void {
            event(new OfflineTicketCreatedBroadcast($event->conversation->ulid));
            event(new ConversationUpdatedBroadcast($event->conversation->ulid, toAdmin: false));
        });
    }

    public function conversationRated(ConversationRated $event): void
    {
        $this->guard(function () use ($event): void {
            $payload = new ConversationRatedPayload($event->conversation->ulid, $event->rating->score);

            event(new PayloadBroadcast(RealtimeEvent::ConversationRated, [RealtimeChannels::admin()], $payload->toArray()));
        });
    }

    public function unseenCountChanged(UnseenCountChanged $event): void
    {
        $this->guard(fn () => event(new UnreadUpdatedBroadcast($event->conversation->ulid)));
    }

    public function queueChanged(QueueChanged $event): void
    {
        $this->guard(fn () => BroadcastQueueCounts::dispatch());
    }

    public function presenceChanged(PresenceChanged $event): void
    {
        $this->guard(function () use ($event): void {
            $payload = new PresenceChangedPayload($event->userId, $event->status);

            event(new PayloadBroadcast(RealtimeEvent::PresenceChanged, [RealtimeChannels::presenceStaff()], $payload->toArray()));
        });
    }

    /** Immediate: the client must drop its session as soon as it can. */
    public function staffSessionRevoked(StaffSessionRevoked $event): void
    {
        $this->guard(function () use ($event): void {
            $payload = new SessionRevokedPayload($event->reason);

            event(new ImmediatePayloadBroadcast(RealtimeEvent::SessionRevoked, [RealtimeChannels::staff($event->userId)], $payload->toArray()));
        });
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
