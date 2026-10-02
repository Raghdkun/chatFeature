<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Events\WaSessionQrUpdated;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Log;

/**
 * The one writer of a session's status and of what OpenWA says about it (the number, the push name, the last error, the QR).
 *
 * OpenWA stays the source of truth: a webhook or a reconciliation writes the status it reports even when the move is not in
 * `SessionStatus::allowedTransitions()` (a delivery may have been missed), and only logs it. The write itself is a guarded
 * `UPDATE ... WHERE status = :seen`, so two deliveries racing each other (or a delivery racing an administrator's action) cannot
 * overwrite one another with a stale read: the loser reads again. Nothing is written, announced or bumped when nothing changed.
 * `WaSessionStatusChanged` / `WaSessionQrUpdated` fire after the write.
 */
final class ApplySessionState
{
    private const ATTEMPTS = 4;

    /**
     * Move the session to `$to` and set the given columns (`phone_e164`, `push_name`, `last_error`), writing only what differs.
     * Leaving `qr` drops the QR image; arriving at `ready` stamps `ready_at` and, unless an error is given, clears the last one.
     *
     * @param  array<string, string|null>  $attributes
     */
    public function transition(WhatsAppSession $session, SessionStatus $to, array $attributes = []): WhatsAppSession
    {
        for ($attempt = 1; $attempt <= self::ATTEMPTS; $attempt++) {
            $current = WhatsAppSession::withTrashed()->find($session->id);

            if ($current === null) {
                return $session;
            }

            $from = $current->status;
            $changes = [];

            foreach ($attributes as $column => $value) {
                if ($current->getAttribute($column) !== $value) {
                    $changes[$column] = $value;
                }
            }

            if ($to !== $from) {
                $changes['status'] = $to->value;

                if (! $from->canTransitionTo($to)) {
                    Log::info('WhatsApp session moved outside the state table (OpenWA is the source of truth).', ['session' => $current->ulid, 'from' => $from->value, 'to' => $to->value]);
                }

                if ($to === SessionStatus::Ready) {
                    $changes['ready_at'] = now();

                    if (! array_key_exists('last_error', $attributes) && $current->last_error !== null) {
                        $changes['last_error'] = null;
                    }
                }

                if ($to !== SessionStatus::Qr && ($current->last_qr_at !== null || $current->getRawOriginal('last_qr') !== null)) {
                    $changes['last_qr'] = null;
                    $changes['last_qr_at'] = null;
                }
            }

            if ($changes === []) {
                return $current;
            }

            $affected = WhatsAppSession::withTrashed()
                ->whereKey($current->id)
                ->where('status', $from->value)
                ->update($changes + ['updated_at' => now()]);

            if ($affected === 1) {
                $fresh = WhatsAppSession::withTrashed()->findOrFail($current->id);
                WaSessionStatusChanged::dispatch($fresh, $from);

                return $fresh;
            }
        }

        return WhatsAppSession::withTrashed()->find($session->id) ?? $session;
    }

    /**
     * What OpenWA reports for the session (`GET /sessions/{id}`, a sync): the status when it is one we know, the number and push name
     * when given, the last error (cleared while the session is healthy, kept while it is down and OpenWA names none).
     */
    public function observe(WhatsAppSession $session, OpenWaSession $remote): WhatsAppSession
    {
        $current = WhatsAppSession::withTrashed()->find($session->id) ?? $session;
        $to = $remote->status ?? $current->status;
        $down = in_array($to, [SessionStatus::Failed, SessionStatus::Disconnected], true);

        $attributes = ['last_error' => $remote->lastError ?? ($down ? $current->last_error : null)];

        if ($remote->phone !== null) {
            $attributes['phone_e164'] = $remote->phone;
        }

        if ($remote->pushName !== null) {
            $attributes['push_name'] = $remote->pushName;
        }

        return $this->transition($current, $to, $attributes);
    }

    /**
     * A fresh QR image (stored encrypted: a QR is a login credential while it is valid) and, when the session was not waiting for a
     * scan yet, the move to `qr`.
     */
    public function qr(WhatsAppSession $session, string $dataUrl): WhatsAppSession
    {
        WhatsAppSession::withTrashed()->whereKey($session->id)->update([
            'last_qr' => Crypt::encryptString($dataUrl),
            'last_qr_at' => now(),
            'updated_at' => now(),
        ]);

        $this->transition(WhatsAppSession::withTrashed()->findOrFail($session->id), SessionStatus::Qr);
        $fresh = WhatsAppSession::withTrashed()->findOrFail($session->id);

        WaSessionQrUpdated::dispatch($fresh);

        return $fresh;
    }
}
