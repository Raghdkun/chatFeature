<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\Chat\Services\MessageText;
use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\Payload;
use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Models\WhatsAppSession;

/**
 * The `session.*` webhooks: `session.status` (`{sessionId, status}`, OpenWA's wire values), `session.qr` (`{sessionId, qr}`, a PNG data
 * URL), `session.authenticated` (`{sessionId, phone, pushName}`: paired, becomes ready), `session.disconnected` (`{sessionId, reason}`)
 * and `session.reconnect_loop` (`{sessionId, attempts, nextDelayMs}`). Every write goes through {@see ApplySessionState}.
 */
final class SessionEventApplier
{
    public function __construct(private readonly ApplySessionState $state) {}

    /**
     * @param  array<array-key, mixed>  $data
     */
    public function apply(WhatsAppSession $session, string $event, array $data): WebhookResult
    {
        switch ($event) {
            case 'session.status':
                $status = SessionStatus::fromOpenWa(Payload::string($data, 'status', 32));

                if ($status === null) {
                    return WebhookResult::ignored('Unknown session status.');
                }

                $this->state->transition($session, $status);

                return WebhookResult::processed();

            case 'session.qr':
                $qr = $data['qr'] ?? ($data['qrCode'] ?? null);

                if (! OpenWaQr::isPngDataUrl($qr)) {
                    return WebhookResult::ignored('The QR code is not a PNG data URL.');
                }

                $this->state->qr($session, $qr);

                return WebhookResult::processed();

            case 'session.authenticated':
                $attributes = array_filter([
                    'phone_e164' => PhoneNumber::e164(Payload::string($data, 'phone', 32)),
                    'push_name' => MessageText::singleLine(Payload::string($data, 'pushName', 200), 120),
                ], static fn (?string $value): bool => $value !== null);

                $this->state->transition($session, SessionStatus::Ready, $attributes);

                return WebhookResult::processed();

            case 'session.disconnected':
                $reason = MessageText::singleLine(Payload::string($data, 'reason', 300), 300);

                $this->state->transition($session, SessionStatus::Disconnected, ['last_error' => $reason === null ? null : 'Disconnected: '.$reason]);

                return WebhookResult::processed();

            case 'session.reconnect_loop':
                $attempts = is_numeric($data['attempts'] ?? null) ? (int) $data['attempts'] : null;
                $seconds = is_numeric($data['nextDelayMs'] ?? null) ? (int) ceil(((int) $data['nextDelayMs']) / 1000) : null;
                $note = 'WhatsApp keeps dropping the connection'.($attempts === null ? '' : ' (attempt '.$attempts.')').($seconds === null ? '' : ', next try in '.$seconds.' s').'.';

                $this->state->transition($session, $session->fresh()->status ?? $session->status, ['last_error' => $note]);

                return WebhookResult::processed();
        }

        return WebhookResult::ignored('Not a session event.');
    }
}
