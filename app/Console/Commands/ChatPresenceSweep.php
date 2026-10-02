<?php

namespace App\Console\Commands;

use App\Domain\Presence\PresenceSweep;
use Illuminate\Console\Command;

/**
 * Re-evaluates agent presence that changes with time alone: silent agents (no heartbeat for the window) become `offline`, automatic
 * agents whose tabs are all hidden become `away`; each change is announced once. Scheduled every minute; safe to run by hand.
 */
class ChatPresenceSweep extends Command
{
    protected $signature = 'chat:presence-sweep';

    protected $description = 'Mark silent agents offline and idle automatic agents away, announcing each change once';

    public function handle(PresenceSweep $sweep): int
    {
        $result = $sweep->run();

        $this->components->info(sprintf(
            'Checked %d agent(s): %d change(s) (%d offline, %d away, %d online).',
            $result['checked'], $result['changed'], $result['offline'], $result['away'], $result['online'],
        ));

        return self::SUCCESS;
    }
}
