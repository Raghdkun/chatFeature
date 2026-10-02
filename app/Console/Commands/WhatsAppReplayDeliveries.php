<?php

namespace App\Console\Commands;

use App\Domain\WhatsApp\Actions\ReplayWebhookDeliveries;
use Illuminate\Console\Command;

/**
 * Queues inbound WhatsApp deliveries again when their job was lost or they ran out of tries (the raw body is kept on the ledger row until
 * a delivery is processed). Scheduled every five minutes.
 */
class WhatsAppReplayDeliveries extends Command
{
    protected $signature = 'whatsapp:replay-deliveries';

    protected $description = 'Queue accepted WhatsApp webhook deliveries again whose job was lost or that failed (bounded budget)';

    public function handle(ReplayWebhookDeliveries $replay): int
    {
        $result = $replay->handle();

        $this->components->info("Queued {$result['requeued']} lost delivery(ies) and {$result['retried']} failed one(s) again.");

        return self::SUCCESS;
    }
}
