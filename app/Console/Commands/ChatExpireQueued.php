<?php

namespace App\Console\Commands;

use App\Domain\Chat\Actions\ExpireQueuedConversations;
use Illuminate\Console\Command;

/**
 * Safety net of the per-chat `ExpireQueuedConversation` job (a lost or late job must not leave a visitor waiting forever): every
 * queued live chat past its queue timeout becomes `missed`. Scheduled every minute.
 */
class ChatExpireQueued extends Command
{
    protected $signature = 'chat:expire-queued';

    protected $description = 'Mark queued chats that nobody accepted before their queue timeout as missed';

    public function handle(ExpireQueuedConversations $expire): int
    {
        $this->components->info('Marked '.$expire->sweep().' queued chat(s) as missed.');

        return self::SUCCESS;
    }
}
