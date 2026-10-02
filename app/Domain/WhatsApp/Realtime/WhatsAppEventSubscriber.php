<?php

namespace App\Domain\WhatsApp\Realtime;

use App\Data\WhatsApp\Events\WaChatUpdatedPayload;
use App\Data\WhatsApp\Events\WaMessageCreatedPayload;
use App\Data\WhatsApp\Events\WaMessageUpdatedPayload;
use App\Data\WhatsApp\Events\WaSessionStatusPayload;
use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Enums\WaRealtimeEvent;
use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Events\WaSessionQrUpdated;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Closure;
use Illuminate\Events\Dispatcher;
use Throwable;

/**
 * Turns the WhatsApp domain events into the broadcasts of `private-whatsapp-admin` (docs/contracts/whatsapp-data-p6.md, "Realtime"):
 * `wa.message.created` (+ `wa.chat.updated`), `wa.message.updated`, `wa.chat.updated`, `wa.session.status`. The payloads are the spine's
 * Data classes, so an agent-visible field can never sneak in, and the QR image is never part of one.
 *
 * Like the live chat's `ChatEventSubscriber`, realtime is an add-on to REST: every handler runs inside `guard()`, so whatever goes wrong
 * here (a payload that cannot be built, Reverb being down) is reported and the webhook or request that raised the event carries on.
 */
final class WhatsAppEventSubscriber
{
    /**
     * @return array<class-string, string>
     */
    public function subscribe(Dispatcher $events): array
    {
        return [
            WaMessageReceived::class => 'messageStored',
            WaMessageSent::class => 'messageStored',
            WaMessageStatusChanged::class => 'messageChanged',
            WaChatLinked::class => 'chatLinked',
            WaChatUpdated::class => 'chatUpdated',
            WaSessionStatusChanged::class => 'sessionChanged',
            WaSessionQrUpdated::class => 'sessionQr',
        ];
    }

    /** A message was recorded (inbound, a phone's own send, or an administrator's reply): the message with its chat, then the chat's list entry. */
    public function messageStored(WaMessageReceived|WaMessageSent $event): void
    {
        $this->guard(function () use ($event): void {
            $message = $this->message($event->message);
            $chat = WaChatData::fromModel($message->chat);

            $this->publish(WaRealtimeEvent::MessageCreated, (new WaMessageCreatedPayload(WaMessageData::fromModel($message), $chat))->toArray());
            $this->publish(WaRealtimeEvent::ChatUpdated, (new WaChatUpdatedPayload($chat))->toArray());
        });
    }

    /** A delivery ack, a failure, or a stored file arriving (`from` is the same status then): the message as it is now. */
    public function messageChanged(WaMessageStatusChanged $event): void
    {
        $this->guard(function () use ($event): void {
            $message = $this->message($event->message);

            $this->publish(WaRealtimeEvent::MessageUpdated, (new WaMessageUpdatedPayload(WaMessageData::fromModel($message)))->toArray());
        });
    }

    public function chatLinked(WaChatLinked $event): void
    {
        $this->publishChat($event->chat);
    }

    public function chatUpdated(WaChatUpdated $event): void
    {
        $this->publishChat($event->chat);
    }

    /** A status change or a new QR: the session as the settings page shows it (a QR is announced, never carried). */
    public function sessionChanged(WaSessionStatusChanged|WaSessionQrUpdated $event): void
    {
        $this->guard(function () use ($event): void {
            $session = WhatsAppSession::withTrashed()->withCount('widgets')->find($event->session->id);

            if ($session !== null) {
                $this->publish(WaRealtimeEvent::SessionStatus, (new WaSessionStatusPayload(WhatsAppSessionData::fromModel($session)))->toArray());
            }
        });
    }

    public function sessionQr(WaSessionQrUpdated $event): void
    {
        $this->sessionChanged($event);
    }

    private function publishChat(WaChat $chat): void
    {
        $this->guard(function () use ($chat): void {
            $this->publish(WaRealtimeEvent::ChatUpdated, (new WaChatUpdatedPayload(WaChatData::fromModel($this->chat($chat))))->toArray());
        });
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function publish(WaRealtimeEvent $event, array $payload): void
    {
        event(new WaPayloadBroadcast($event, $payload));
    }

    /** The message read again with what its payload names (the model the event carries may predate the write that caused it). */
    private function message(WaMessage $message): WaMessage
    {
        return WaMessage::query()->with(['chat.session', 'chat.widget', 'chat.category', 'sentBy'])->findOrFail($message->id);
    }

    private function chat(WaChat $chat): WaChat
    {
        return WaChat::query()->with(['session', 'widget', 'category'])->findOrFail($chat->id);
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
