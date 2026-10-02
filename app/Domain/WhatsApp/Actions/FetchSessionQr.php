<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WhatsAppSession;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\Gate;

/**
 * The QR code of a session that is waiting for a scan, for the administrator who is looking at it. Only while the status is `qr` (a QR is a
 * login credential: nothing else ever gets it). The last one the `session.qr` webhook delivered is served while it is younger than
 * {@see self::FRESH_SECONDS}; otherwise (the webhook never arrived: a private callback address OpenWA refuses, for example) it is
 * fetched from OpenWA and stored. The page polls every few seconds and OpenWA's own throttler (10 requests a second per client address)
 * must never become the administrator's problem: a throttled fetch serves the last known code.
 */
final class FetchSessionQr
{
    /** A QR lives about 60 s at OpenWA (recorded) and the `session.qr` webhook refreshes the stored one: serve it for most of that. */
    public const FRESH_SECONDS = 45;

    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly ApplySessionState $state,
    ) {}

    /**
     * @return array{qr: string, updatedAt: CarbonInterface}
     */
    public function handle(WhatsAppSession $session, User $actor): array
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);

        if ($session->status !== SessionStatus::Qr) {
            throw new ApiProblemException(409, 'qr_not_available', __('This session is not waiting for a scan.'), ['status' => $session->status->value]);
        }

        if ($session->hasQr() && $session->last_qr_at !== null && $session->last_qr_at->gt(now()->subSeconds(self::FRESH_SECONDS))) {
            return ['qr' => (string) $session->last_qr, 'updatedAt' => $session->last_qr_at];
        }

        if ($session->openwa_session_id === null) {
            throw new ApiProblemException(409, 'qr_not_available', __('This session is not waiting for a scan.'), ['status' => $session->status->value]);
        }

        try {
            $remote = $this->openWa->getQr($session->openwa_session_id);
        } catch (OpenWaRejected $rejected) {
            // 400: OpenWA is not (or no longer) waiting for a scan: hand back whatever the last QR was, else say there is none yet.
            if ($rejected->status === 400 || $rejected->status === 429) {
                return $this->lastKnown($session, throttled: $rejected->status === 429);
            }

            throw OpenWaProblem::from($rejected);
        } catch (OpenWaUnavailable $unavailable) {
            if ($session->hasQr()) {
                return $this->lastKnown($session);
            }

            throw OpenWaProblem::from($unavailable);
        }

        // Stored only while the session is still waiting for the scan this code is for: a webhook that said `ready` while OpenWA was asked wins.
        $session = $this->state->qr($session, $remote->dataUrl, SessionStatus::Qr);

        if ($session->status !== SessionStatus::Qr || ! $session->hasQr()) {
            throw new ApiProblemException(409, 'qr_not_available', __('This session is not waiting for a scan.'), ['status' => $session->status->value]);
        }

        return ['qr' => (string) $session->last_qr, 'updatedAt' => $session->last_qr_at ?? now()];
    }

    /**
     * @return array{qr: string, updatedAt: CarbonInterface}
     */
    private function lastKnown(WhatsAppSession $session, bool $throttled = false): array
    {
        if (! $session->hasQr() || $session->last_qr_at === null) {
            if ($throttled) {
                throw ApiProblemException::rateLimited(__('OpenWA is busy. Try again in a moment.'), 2);
            }

            throw new ApiProblemException(409, 'qr_not_available', __('The QR code is not ready yet. Try again in a moment.'), ['status' => $session->status->value]);
        }

        return ['qr' => (string) $session->last_qr, 'updatedAt' => $session->last_qr_at];
    }
}
