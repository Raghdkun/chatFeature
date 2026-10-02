<?php

namespace App\Console\Commands;

use App\Domain\Chat\Realtime\Sockets\RealtimeSweep;
use Illuminate\Console\Command;

/**
 * The stale-socket cut-off's sweep (docs/realtime.md, "Cutting a socket off"): follow-ups and retries of socket terminations, the
 * sockets of visitor tokens that expired, a staff grant that lost its conversation. Scheduled every minute; safe to run by hand.
 */
class ChatRealtimeSweep extends Command
{
    protected $signature = 'chat:realtime-sweep';

    protected $description = 'Close the websockets of visitor tokens that expired and of staff who lost a conversation, and repeat or retry earlier cut-offs';

    public function handle(RealtimeSweep $sweep): int
    {
        $result = $sweep->run();

        $this->components->info(sprintf(
            'Terminated %d tag(s) (%d failed, %d given up); %d visitor session(s) cut; %d staff member(s) lost a conversation; %d grant(s) pruned.',
            $result['terminated'], $result['failed'], $result['dropped'], $result['visitor_sessions'], $result['staff_cut'], $result['grants_pruned'],
        ));

        return self::SUCCESS;
    }
}
