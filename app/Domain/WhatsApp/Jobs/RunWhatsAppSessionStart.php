<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Actions\ApplySessionState;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Models\WhatsAppSession;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Throwable;

/**
 * The slow half of starting a session: asks OpenWA to start the engine (`POST /sessions/{id}/start` blocks until it is up and answers
 * `504` when it never gets there) and writes what OpenWA answers. The status was already moved to `starting` by `StartWhatsAppSession`;
 * whatever OpenWA says wins (`qr`, `ready` for a paired session), and a failure becomes `failed` with a reason an administrator can read.
 * Runs once: the administrator starts again.
 */
class RunWhatsAppSessionStart implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 1;

    public int $timeout = 150;

    public function __construct(public readonly int $sessionId) {}

    public function handle(OpenWaClient $openWa, ApplySessionState $state): void
    {
        $session = WhatsAppSession::query()->find($this->sessionId);

        if ($session === null || $session->status !== SessionStatus::Starting || $session->openwa_session_id === null) {
            return;
        }

        try {
            // The call BLOCKS for 6-25 s while the engine comes up, and the webhooks (`initializing`, `qr_ready`, `session.qr`, even `ready`
            // for a fast scan) land during it: its answer describes the moment OpenWA built it, so it may only move a session that is still
            // `starting` (it never overwrites what a newer webhook said).
            $state->observe($session, $openWa->startSession($session->openwa_session_id), onlyFrom: SessionStatus::Starting);
        } catch (OpenWaRejected $rejected) {
            // "Already started / starting" is a 400: the engine is running, so look at what it reports instead of failing.
            if ($rejected->status === 400 && $this->reconcile($openWa, $state, $session)) {
                return;
            }

            $this->fail($state, $session, OpenWaProblem::reason($rejected));
        } catch (OpenWaUnavailable $unavailable) {
            $this->fail($state, $session, OpenWaProblem::reason($unavailable).'. The engine may not have finished starting in time: check OpenWA, then start the session again.');
        }
    }

    public function failed(Throwable $exception): void
    {
        $session = WhatsAppSession::query()->find($this->sessionId);

        if ($session !== null && $session->status === SessionStatus::Starting) {
            app(ApplySessionState::class)->transition($session, SessionStatus::Failed, ['last_error' => 'The session could not be started.']);
        }
    }

    private function reconcile(OpenWaClient $openWa, ApplySessionState $state, WhatsAppSession $session): bool
    {
        try {
            $state->observe($session, $openWa->getSession((string) $session->openwa_session_id), onlyFrom: SessionStatus::Starting);

            return true;
        } catch (Throwable) {
            return false;
        }
    }

    private function fail(ApplySessionState $state, WhatsAppSession $session, string $reason): void
    {
        $state->transition($session, SessionStatus::Failed, ['last_error' => mb_substr($reason, 0, 900)], onlyFrom: SessionStatus::Starting);
    }
}
