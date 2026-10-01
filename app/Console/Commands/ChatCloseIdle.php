<?php

namespace App\Console\Commands;

use App\Domain\Chat\Actions\CloseIdleConversations;
use Illuminate\Console\Command;

/**
 * Closes active chats with no message from either side for the widget's idle timeout (reason `idle`, no rating prompt),
 * in chunks of 500 with a guarded update. Scheduled every minute.
 */
class ChatCloseIdle extends Command
{
    protected $signature = 'chat:close-idle';

    protected $description = 'Close active chats that went idle';

    public function handle(CloseIdleConversations $close): int
    {
        $this->components->info('Closed '.$close->handle().' idle chat(s).');

        return self::SUCCESS;
    }
}
