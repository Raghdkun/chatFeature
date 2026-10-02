<?php

namespace App\Console\Commands;

use App\Domain\WhatsApp\Actions\ReconcileSessions;
use Illuminate\Console\Command;

/**
 * Asks OpenWA what it knows about every session that should be doing something and writes the answer (a webhook that was lost only delays
 * the dashboard by a minute), and fails the replies nobody ever confirmed. Scheduled every minute. An OpenWA that is down is reported and is
 * not a failure of the command (the scheduler would flag every minute): see docs/runbook.md.
 */
class WhatsAppReconcileSessions extends Command
{
    protected $signature = 'whatsapp:reconcile-sessions';

    protected $description = 'Reconcile WhatsApp sessions with OpenWA and fail replies that were never confirmed';

    public function handle(ReconcileSessions $reconcile): int
    {
        $result = $reconcile->handle();

        if ($result['unreachable']) {
            $this->components->warn('OpenWA could not be reached (or refused the API key): the sessions were not reconciled.');
        }

        $this->components->info("Checked {$result['checked']} session(s), {$result['changed']} changed, {$result['failed_replies']} unconfirmed reply(ies) failed.");

        return self::SUCCESS;
    }
}
