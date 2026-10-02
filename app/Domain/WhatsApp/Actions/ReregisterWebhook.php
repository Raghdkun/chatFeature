<?php

namespace App\Domain\WhatsApp\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\User;
use App\Models\WhatsAppSession;
use Illuminate\Support\Facades\Gate;

/**
 * `POST /whatsapp/sessions/{ulid}/webhook`: registers the session's webhook again with a NEW secret and removes the old webhook at OpenWA.
 * The recovery for a webhook that does not verify any more (deliveries answered 401 for ever): the secret was lost with an application key
 * change, someone changed the webhook at OpenWA, or a database was restored. Normal use never needs it: the webhook is registered once, when
 * the session first starts.
 */
final class ReregisterWebhook
{
    public function __construct(
        private readonly StartWhatsAppSession $start,
        private readonly AuditLogger $audit,
    ) {}

    public function handle(WhatsAppSession $session, User $actor): WhatsAppSession
    {
        Gate::forUser($actor)->authorize('manageSessions', $session);

        $session = WhatsAppSession::query()->findOrFail($session->id);
        $session = $this->start->registerWebhook($session, replace: true);
        $this->audit->record('whatsapp.session.webhook_reregistered', $session, [], $actor);

        return $session->refresh();
    }
}
