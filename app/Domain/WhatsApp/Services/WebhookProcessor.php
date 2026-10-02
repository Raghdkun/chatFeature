<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\WhatsApp\Support\Payload;
use App\Models\WhatsAppSession;

/**
 * Applies one verified OpenWA delivery (`{event, timestamp, sessionId, idempotencyKey, deliveryId, data}`) to the application: routes the
 * nine events the application handles to their recorder; everything else is acknowledged as `ignored` (a newer OpenWA may send events
 * this version has never heard of). Runs inside the queued `ProcessWebhookDelivery` job and is safe to run twice (the recorders are
 * idempotent).
 */
class WebhookProcessor
{
    public function __construct(
        private readonly InboundMessageRecorder $messages,
        private readonly AckRecorder $acks,
        private readonly SessionEventApplier $sessions,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload
     *
     * @throws AckBeforeMessage
     */
    public function process(WhatsAppSession $session, array $payload, string $fallbackEvent): WebhookResult
    {
        $event = Payload::string($payload, 'event', 48) ?? $fallbackEvent;
        $data = Payload::array($payload, 'data');

        // `sessionId` is the OpenWA session UUID (recorded): a delivery that names another session than the one this URL belongs to is not
        // ours to apply (the signature already proved who sent it; this catches a webhook wired to the wrong place).
        $named = Payload::string($payload, 'sessionId', 64);

        if ($named !== null && $session->openwa_session_id !== null && ! hash_equals(strtolower($session->openwa_session_id), strtolower($named))) {
            return WebhookResult::ignored('Delivered for another OpenWA session.');
        }

        return match ($event) {
            'message.received', 'message.sent' => $this->messages->record($session, $data, $event),
            'message.ack', 'message.failed' => $this->acks->record($session, $data, $event),
            'session.status', 'session.qr', 'session.authenticated', 'session.disconnected', 'session.reconnect_loop' => $this->sessions->apply($session, $event, $data, Payload::moment($payload['timestamp'] ?? null)?->toImmutable()),
            default => WebhookResult::ignored('Event not handled.'),
        };
    }
}
