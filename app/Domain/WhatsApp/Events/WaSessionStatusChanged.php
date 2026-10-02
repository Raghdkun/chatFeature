<?php

namespace App\Domain\WhatsApp\Events;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Models\WhatsAppSession;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A session's status changed (`$from` is null when it is unknown, for example after a reconciliation). Dispatched by the session
 * actions and the `session.*` webhook processor (6A); consumed by 6A's broadcast (`wa.session.status`) and by the availability cache of
 * the widgets that use the session.
 */
final class WaSessionStatusChanged implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly WhatsAppSession $session,
        public readonly ?SessionStatus $from = null,
    ) {}
}
