<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\WhatsApp\Contracts\OpenWaClient;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWaProblem;
use App\Domain\Widgets\Availability\AvailabilityService;
use App\Models\User;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Sleep;

/**
 * An administrator deletes a session: OpenWA removes it (its webhooks and its copy of the messages go with it; a session OpenWA no longer
 * knows is already gone), then it is SOFT-deleted here: its name is free again, its chats stay readable in the inbox, widgets linked to it
 * behave as unlinked, and the secrets (webhook secret, QR, OpenWA ids) are dropped. When OpenWA cannot be asked the delete is refused,
 * unless `$force` says delete here anyway (the session may then stay behind at OpenWA).
 */
final class DeleteWhatsAppSession
{
    private const TEARDOWN_PAUSES = [1, 2, 3];

    public function __construct(
        private readonly OpenWaClient $openWa,
        private readonly AuditLogger $audit,
        private readonly AvailabilityService $availability,
    ) {}

    public function handle(WhatsAppSession $session, User $actor, bool $force = false): void
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);
        $remoteDeleted = $session->openwa_session_id === null || $this->deleteRemote($session->openwa_session_id, $force);

        $widgets = Widget::query()->where('whatsapp_session_id', $session->id)->get();

        $session->forceFill([
            'webhook_secret' => null,
            'last_qr' => null,
            'last_qr_at' => null,
            'openwa_session_id' => null,
            'openwa_webhook_id' => null,
            'webhook_registered_at' => null,
        ])->save();
        $session->delete();

        $widgets->each(fn (Widget $widget) => $this->availability->forget($widget));
        $this->audit->record('whatsapp.session.deleted', $session, ['forced' => $force && ! $remoteDeleted], $actor);
    }

    /** True when OpenWA confirmed (or no longer knows) the session; false only for a forced delete that could not ask. */
    private function deleteRemote(string $openWaId, bool $force): bool
    {
        foreach ([...self::TEARDOWN_PAUSES, null] as $pause) {
            try {
                $this->openWa->deleteSession($openWaId);

                return true;
            } catch (OpenWaRejected $rejected) {
                if ($rejected->isNotFound()) {
                    return true;
                }

                if (OpenWaProblem::isTeardownPending($rejected) && $pause !== null) {
                    Sleep::for($pause)->seconds();

                    continue;
                }

                if ($force) {
                    return false;
                }

                throw OpenWaProblem::from($rejected);
            } catch (OpenWaUnavailable $unavailable) {
                if ($force) {
                    return false;
                }

                throw OpenWaProblem::from($unavailable);
            }
        }

        return false;
    }
}
