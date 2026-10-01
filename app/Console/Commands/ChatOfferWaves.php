<?php

namespace App\Console\Commands;

use App\Domain\Chat\Actions\OfferDueWaves;
use Illuminate\Console\Command;

/**
 * Safety net of the delayed `OfferNextWave` jobs: queued live chats whose next routing wave is due but was never made (a lost or
 * failed job, or the `sync` queue driver) are offered to the next agents. Scheduled every minute.
 */
class ChatOfferWaves extends Command
{
    protected $signature = 'chat:offer-waves';

    protected $description = 'Make the routing waves of queued chats that are due but were never offered';

    public function handle(OfferDueWaves $waves): int
    {
        $this->components->info('Advanced the routing of '.$waves->sweep().' queued chat(s).');

        return self::SUCCESS;
    }
}
