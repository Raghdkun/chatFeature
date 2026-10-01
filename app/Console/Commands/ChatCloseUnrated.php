<?php

namespace App\Console\Commands;

use App\Domain\Chat\Actions\CloseUnratedConversations;
use Illuminate\Console\Command;

/**
 * Closes ended chats the visitor never rated once the rating window (`chat.rating_window_minutes`) is over (reason `timeout`).
 * Scheduled every minute.
 */
class ChatCloseUnrated extends Command
{
    protected $signature = 'chat:close-unrated';

    protected $description = 'Close ended chats whose rating window has passed';

    public function handle(CloseUnratedConversations $close): int
    {
        $this->components->info('Closed '.$close->handle().' unrated chat(s).');

        return self::SUCCESS;
    }
}
