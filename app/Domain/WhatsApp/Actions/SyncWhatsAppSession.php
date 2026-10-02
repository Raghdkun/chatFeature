<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;
use Throwable;

/**
 * Reconciles a session with OpenWA, which stays the source of truth: asks what it knows (`GET /sessions/{id}`) and writes that (status,
 * number, push name, last error); a session waiting for a scan whose QR never arrived by webhook is fetched. A session OpenWA no longer
 * knows becomes `failed` ("start" then creates it again). The administrator's button and the scheduled `whatsapp:reconcile-sessions` both
 * end up here.
 */
final class SyncWhatsAppSession
{
    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly ApplySessionState $state,
        private readonly AuditLogger $audit,
    ) {}

    /** The administrator's button: authorised, audited, and OpenWA's failures are answered. */
    public function handle(WhatsAppSession $session, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        try {
            $session = $this->reconcile(WhatsAppSession::query()->findOrFail($session->id));
        } catch (OpenWaRejected|OpenWaUnavailable $exception) {
            throw OpenWaProblem::from($exception);
        }

        $this->audit->record('whatsapp.session.synced', $session, ['status' => $session->status->value], $actor);

        return $session;
    }

    /**
     * Write what OpenWA reports for the session.
     *
     * @throws OpenWaUnavailable|OpenWaRejected when OpenWA cannot be asked or refuses the key
     */
    public function reconcile(WhatsAppSession $session): WhatsAppSession
    {
        if ($session->openwa_session_id === null) {
            return $session;
        }

        // The status as it is now, read BEFORE the question goes out: OpenWA's answer describes the moment it built it, so it may only move a
        // session that still has this status. A webhook (or an administrator's Start / Stop) that changed it in the meantime is newer.
        $current = WhatsAppSession::withTrashed()->find($session->id);
        $seen = $current === null ? $session->status : $current->status;

        try {
            $remote = $this->openWa->getSession($session->openwa_session_id);
        } catch (OpenWaRejected $rejected) {
            if (! $rejected->isNotFound()) {
                throw $rejected;
            }

            return $this->state->transition($session, SessionStatus::Failed, ['last_error' => 'OpenWA no longer knows this session. Start it again to create it.'], $seen);
        }

        $session = $this->state->observe($session, $remote, $seen);

        if ($session->status === SessionStatus::Qr && ! $session->hasQr()) {
            $session = $this->fetchQr($session);
        }

        return $session;
    }

    private function fetchQr(WhatsAppSession $session): WhatsAppSession
    {
        try {
            return $this->state->qr($session, $this->openWa->getQr((string) $session->openwa_session_id)->dataUrl, SessionStatus::Qr);
        } catch (Throwable) {
            // A QR that is not ready yet (400) or an unusable one: the next reconciliation or webhook has it.
            return $session;
        }
    }
}
