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
 * fetched from OpenWA and stored. WhatsApp rotates the code about every 20 seconds, and the page polls.
 */
final class FetchSessionQr
{
    public const FRESH_SECONDS = 15;

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
            if ($rejected->status === 400) {
                return $this->lastKnown($session);
            }

            throw OpenWaProblem::from($rejected);
        } catch (OpenWaUnavailable $unavailable) {
            if ($session->hasQr()) {
                return $this->lastKnown($session);
            }

            throw OpenWaProblem::from($unavailable);
        }

        $session = $this->state->qr($session, $remote->dataUrl);

        return ['qr' => (string) $session->last_qr, 'updatedAt' => $session->last_qr_at ?? now()];
    }

    /**
     * @return array{qr: string, updatedAt: CarbonInterface}
     */
    private function lastKnown(WhatsAppSession $session): array
    {
        if (! $session->hasQr() || $session->last_qr_at === null) {
            throw new ApiProblemException(409, 'qr_not_available', __('The QR code is not ready yet. Try again in a moment.'), ['status' => $session->status->value]);
        }

        return ['qr' => (string) $session->last_qr, 'updatedAt' => $session->last_qr_at];
    }
}
