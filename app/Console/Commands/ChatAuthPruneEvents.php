<?php

namespace App\Console\Commands;

use App\Models\ProcessedEvent;
use Illuminate\Console\Command;

/**
 * Deletes idempotency ledger rows (`processed_events`) older than the retention window. The NATS consumer already
 * does this hourly; the command exists for ad-hoc and scheduled use.
 */
class ChatAuthPruneEvents extends Command
{
    protected $signature = 'chat:auth:prune-events
        {--days= : Keep this many days (default: nats.retention_days, 30)}';

    protected $description = 'Prune processed pizzasys events (the NATS idempotency ledger) older than the retention window';

    public function handle(): int
    {
        $option = $this->option('days');
        $default = config('nats.retention_days', 30);
        $days = $option !== null ? $option : $default;

        if (! is_numeric($days) || (int) $days < 1) {
            $this->components->error('--days must be a positive integer.');

            return self::INVALID;
        }

        $removed = ProcessedEvent::pruneOlderThan((int) $days);

        $this->components->info("Pruned {$removed} processed event(s) older than {$days} day(s).");

        return self::SUCCESS;
    }
}
