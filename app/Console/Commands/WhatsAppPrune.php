<?php

namespace App\Console\Commands;

use App\Domain\WhatsApp\Actions\PruneWhatsApp;
use Illuminate\Console\Command;

/**
 * Housekeeping: webhook ledger rows past their retention, hand-off tickets that expired unused, and stored images no message references.
 * Chats and messages are never deleted. Scheduled daily.
 */
class WhatsAppPrune extends Command
{
    protected $signature = 'whatsapp:prune
        {--deliveries-days= : How long webhook ledger rows are kept (default: config whatsapp.prune.deliveries_days)}
        {--tickets-days= : How long an expired, unused hand-off ticket is kept}
        {--media-hours= : How long an unreferenced stored image is kept}';

    protected $description = 'Delete old webhook deliveries, expired unused hand-off tickets and orphan WhatsApp media';

    public function handle(PruneWhatsApp $prune): int
    {
        $result = $prune->handle(
            $this->days('deliveries-days', 'deliveries_days', 30),
            $this->days('tickets-days', 'tickets_days', 1),
            $this->days('media-hours', 'media_hours', 24),
        );

        $this->components->info("Deleted {$result['deliveries']} webhook delivery(ies), {$result['tickets']} expired ticket(s) and {$result['media']} orphan file(s).");

        return self::SUCCESS;
    }

    private function days(string $option, string $config, int $default): int
    {
        $value = $this->option($option);

        return is_numeric($value) ? max(0, (int) $value) : max(0, (int) config('whatsapp.prune.'.$config, $default));
    }
}
