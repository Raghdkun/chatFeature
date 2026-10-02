<?php

namespace App\Domain\WhatsApp\Jobs;

use App\Domain\WhatsApp\Actions\SyncWhatsAppSession;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaRejected;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Models\WhatsAppSession;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;

/**
 * Asks OpenWA what it knows about one session right now and writes it ({@see SyncWhatsAppSession::reconcile()}): what a refused send leaves
 * behind when it says OpenWA has no engine for a number the app believed `ready`. The minute-by-minute `whatsapp:reconcile-sessions` would
 * get there too; this is the quick path. A failure is not retried (the scheduled run is the net).
 */
class ReconcileWhatsAppSession implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    public int $tries = 1;

    public int $timeout = 60;

    public function __construct(public readonly int $sessionId) {}

    public function handle(SyncWhatsAppSession $sync): void
    {
        $session = WhatsAppSession::query()->find($this->sessionId);

        if ($session === null) {
            return;
        }

        try {
            $sync->reconcile($session);
        } catch (OpenWaRejected|OpenWaUnavailable) {
            // The scheduled reconciliation tries again.
        }
    }
}
