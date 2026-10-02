<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Services\SendCounter;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Log;

/**
 * The scheduled safety net (`whatsapp:reconcile-sessions`, every minute): OpenWA stays the source of truth, webhooks are at-least-once but
 * can be lost (the app was down, OpenWA could not call back), so every session that is expected to be doing something is asked what
 * OpenWA thinks and the answer is written ({@see SyncWhatsAppSession::reconcile()}). Stops at the first sign that OpenWA is unreachable or
 * refuses the key (the rest would fail the same way, one connect timeout each) and says so once every few minutes in the log.
 *
 * Also fails the replies nobody ever confirmed: a send that was handed to OpenWA but never answered stays `pending` waiting for the
 * `message.sent` webhook; after `whatsapp.send.unconfirmed_after_minutes` it is `failed` ("may or may not have been delivered") and its
 * slot of the daily cap is given back.
 */
final class ReconcileSessions
{
    /** The run is bounded: whatever is left waits for the next minute. */
    private const BUDGET_SECONDS = 50;

    public function __construct(
        private readonly SyncWhatsAppSession $sync,
        private readonly SendCounter $counter,
    ) {}

    /**
     * @return array{checked: int, changed: int, unreachable: bool, failed_replies: int}
     */
    public function handle(): array
    {
        $checked = 0;
        $changed = 0;
        $unreachable = false;
        $deadline = microtime(true) + self::BUDGET_SECONDS;

        $sessions = WhatsAppSession::query()
            ->whereNotNull('openwa_session_id')
            ->whereIn('status', [SessionStatus::Starting->value, SessionStatus::Qr->value, SessionStatus::Ready->value, SessionStatus::Disconnected->value, SessionStatus::Failed->value])
            ->orderBy('id')
            ->get();

        foreach ($sessions as $session) {
            if (microtime(true) > $deadline) {
                break;
            }

            try {
                $after = $this->sync->reconcile($session);
            } catch (OpenWaUnavailable|OpenWaRejected $exception) {
                // Everything that stops the run stops it for every session after this one: an unreachable OpenWA, a refused key, or OpenWA's
                // own throttler (10 requests a second per client address). The throttle is not a fault: the next minute carries on.
                if (! ($exception instanceof OpenWaRejected && $exception->status === 429)) {
                    $unreachable = true;
                    $this->warn($exception instanceof OpenWaRejected && $exception->isUnauthorized() ? 'OpenWA did not accept the API key.' : 'OpenWA could not be reached.');
                }

                break;
            }

            $checked++;

            if ($after->status !== $session->status || $after->phone_e164 !== $session->phone_e164 || $after->last_error !== $session->last_error) {
                $changed++;
            }
        }

        return ['checked' => $checked, 'changed' => $changed, 'unreachable' => $unreachable, 'failed_replies' => $this->failUnconfirmedReplies()];
    }

    /** Replies that were never confirmed: failed, with the reason, and their slots given back. */
    private function failUnconfirmedReplies(): int
    {
        $cutoff = now()->subMinutes(max(1, (int) config('whatsapp.send.unconfirmed_after_minutes', 30)));
        $failed = 0;

        WaMessage::query()
            ->with('chat')
            ->where('status', WaMessageStatus::Pending->value)
            ->where('direction', 'out')
            ->whereNull('wa_message_id')
            ->where('created_at', '<', $cutoff)
            ->orderBy('id')
            ->chunkById(100, function ($messages) use (&$failed): void {
                foreach ($messages as $message) {
                    $updated = WaMessage::query()->whereKey($message->id)->where('status', WaMessageStatus::Pending->value)->whereNull('wa_message_id')->update([
                        'status' => WaMessageStatus::Failed->value,
                        'error' => 'WhatsApp never confirmed this message. It may or may not have been delivered: check the phone before sending it again.',
                        'updated_at' => now(),
                    ]);

                    if ($updated === 1) {
                        $failed++;
                        $this->counter->release($message->chat->session_id, $message->created_at ?? now());
                        WaMessageStatusChanged::dispatch($message->refresh(), WaMessageStatus::Pending);
                    }
                }
            });

        return $failed;
    }

    /** A line in the log, at most once every five minutes: a minute-by-minute warning would bury the log while OpenWA is down. */
    private function warn(string $message): void
    {
        if (Cache::add('whatsapp:reconcile:warned', true, 300)) {
            Log::warning('WhatsApp reconciliation: '.$message);
        }
    }
}
