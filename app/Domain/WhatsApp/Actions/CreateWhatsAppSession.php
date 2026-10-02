<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaSession;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Sleep;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * An administrator adds a WhatsApp session: the name is checked (3-50 letters, digits, hyphens; free among live sessions), the session is
 * created at OpenWA, and only then does it exist here (nothing is left behind when OpenWA refuses). It starts as `created`: connecting a
 * phone is `StartWhatsAppSession`. A name OpenWA is still tearing down (`409 SESSION_NAME_TEARDOWN_PENDING`, after a delete) is retried a
 * few times before the administrator is asked to try again.
 */
final class CreateWhatsAppSession
{
    /** Tries at a name OpenWA is still releasing, and the pause before each retry (seconds). */
    private const TEARDOWN_PAUSES = [1, 2, 3];

    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(string $name, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', WhatsAppSession::class);

        if (preg_match(WhatsAppSession::NAME_PATTERN, $name) !== 1) {
            throw ValidationException::withMessages(['name' => [__('A session name has 3 to 50 letters, digits or hyphens.')]]);
        }

        if (WhatsAppSession::query()->where('name', $name)->exists()) {
            throw $this->taken();
        }

        $remote = $this->createRemote($name);

        try {
            $session = WhatsAppSession::query()->create([
                'name' => $name,
                'openwa_session_id' => $remote->id,
                'status' => SessionStatus::Created,
            ]);
        } catch (UniqueConstraintViolationException) {
            $this->discardRemote($remote);

            throw $this->taken();
        }

        $this->audit->record('whatsapp.session.created', $session, ['name' => $name], $actor);

        return $session->refresh();
    }

    /**
     * The session at OpenWA, created or (with retries while the name is being torn down) refused with a problem the API can answer with.
     *
     * @throws ApiProblemException
     */
    public function createRemote(string $name): OpenWaSession
    {
        foreach ([...self::TEARDOWN_PAUSES, null] as $pause) {
            try {
                return $this->openWa->createSession($name);
            } catch (OpenWaRejected $rejected) {
                if (OpenWaProblem::isTeardownPending($rejected) && $pause !== null) {
                    Sleep::for($pause)->seconds();

                    continue;
                }

                if ($rejected->isConflict() && ! OpenWaProblem::isTeardownPending($rejected)) {
                    throw ApiProblemException::conflict('openwa_session_exists', __('OpenWA already has a session with this name.'));
                }

                throw OpenWaProblem::from($rejected);
            } catch (OpenWaUnavailable $unavailable) {
                throw OpenWaProblem::from($unavailable);
            }
        }

        throw OpenWaProblem::from(new OpenWaRejected(OpenWaProblem::TEARDOWN_PENDING, 409));
    }

    private function taken(): ApiProblemException
    {
        return ApiProblemException::conflict('session_name_taken', __('A session with this name already exists.'));
    }

    /** Best effort: the session OpenWA just created for a name that turned out to be taken here must not stay behind. */
    private function discardRemote(OpenWaSession $remote): void
    {
        try {
            $this->openWa->deleteSession($remote->id);
        } catch (Throwable) {
            // Nothing more can be done here; the administrator can delete it in OpenWA.
        }
    }
}
