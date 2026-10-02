<?php

namespace App\Domain\WhatsApp\Services;

use App\Domain\Chat\Services\MessageText;
use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaQr;
use App\Domain\WhatsApp\Support\Payload;
use App\Domain\WhatsApp\Support\PhoneNumber;
use App\Models\WhatsAppSession;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;

/**
 * The `session.*` webhooks: `session.status` (`{sessionId, status}`, OpenWA's wire values), `session.qr` (`{sessionId, qr}`, a PNG data
 * URL), `session.authenticated` (`{sessionId, phone, pushName}`: paired, becomes ready), `session.disconnected` (`{sessionId, reason}`)
 * and `session.reconnect_loop` (`{sessionId, attempts, nextDelayMs}`). Every write goes through {@see ApplySessionState}.
 */
final class SessionEventApplier
{
    /** The lock that makes the age check and the write of one session's events a single step. */
    public const LOCK_PREFIX = 'wa:session-events-lock:';

    /** Longest a holder keeps it (the work is a few small queries). */
    private const LOCK_SECONDS = 15;

    public function __construct(private readonly ApplySessionState $state) {}

    /**
     * @param  array<array-key, mixed>  $data
     * @param  CarbonImmutable|null  $at  When OpenWA raised the event (the envelope's `timestamp`, millisecond precision)
     */
    public function apply(WhatsAppSession $session, string $event, array $data, ?CarbonImmutable $at = null): WebhookResult
    {
        // OpenWA raises a session's events within milliseconds of each other and the deliveries are processed in parallel: "is this older than
        // what was applied" and the write are ONE step per session, or an older event that passed the check first can be written after the
        // newer one (a `ready` session shown as `starting`, found by the P6 e2e with 25 rounds of three events at once). A lock that cannot be
        // had in time fails the delivery (its job is retried), it never skips the order.
        return Cache::lock(self::LOCK_PREFIX.$session->id, self::LOCK_SECONDS)
            ->block(max(1, (int) config('whatsapp.webhook.session_lock_wait_seconds', 10)), fn (): WebhookResult => $this->applyOrdered($session, $event, $data, $at));
    }

    /**
     * @param  array<array-key, mixed>  $data
     */
    private function applyOrdered(WhatsAppSession $session, string $event, array $data, ?CarbonImmutable $at): WebhookResult
    {
        // Deliveries are independent and not ordered (recorded): a `qr_ready` that overtook the `ready` after it must not undo it.
        if ($this->isStale($session, $at)) {
            return WebhookResult::ignored('Older than what was already applied to this session.');
        }

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

    /**
     * Whether an event is older than the newest one already applied to this session (kept in the cache, millisecond precision, for an
     * hour: the window in which deliveries can swap places; the scheduled reconciliation repairs anything beyond it).
     */
    private function isStale(WhatsAppSession $session, ?CarbonImmutable $at): bool
    {
        if ($at === null) {
            return false;
        }

        $key = 'wa:session-event:'.$session->id;
        $moment = (int) $at->getPreciseTimestamp(3);
        $latest = (int) Cache::get($key, 0);

        if ($moment < $latest) {
            return true;
        }

        Cache::put($key, $moment, 3600);

        return false;
    }
}
