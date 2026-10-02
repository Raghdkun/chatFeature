<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;

/**
 * An administrator stops a running session: OpenWA tears the engine down (it stays down until started again) and the status follows what
 * OpenWA answers (`disconnected`). A session OpenWA no longer knows is simply down.
 */
final class StopWhatsAppSession
{
    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly ApplySessionState $state,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(WhatsAppSession $session, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);

        if (! $session->status->canStop() || $session->openwa_session_id === null) {
            throw new ApiProblemException(409, 'session_not_stoppable', __('This session is not running.'), ['status' => $session->status->value]);
        }

        try {
            $remote = $this->openWa->stopSession($session->openwa_session_id);
            $session = $this->state->observe($session, $remote);

            if ($session->status->isRunning()) {
                $session = $this->state->transition($session, SessionStatus::Disconnected);
            }
        } catch (OpenWaRejected $rejected) {
            if (! $rejected->isNotFound()) {
                throw OpenWaProblem::from($rejected);
            }

            $session = $this->state->transition($session, SessionStatus::Disconnected, ['last_error' => 'OpenWA no longer knows this session.']);
        } catch (OpenWaUnavailable $unavailable) {
            throw OpenWaProblem::from($unavailable);
        }

        $this->audit->record('whatsapp.session.stopped', $session, [], $actor);

        return $session;
    }
}
