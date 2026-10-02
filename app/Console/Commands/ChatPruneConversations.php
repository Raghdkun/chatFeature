<?php

namespace App\Console\Commands;

use App\Domain\Privacy\Actions\PruneConversations;
use Illuminate\Console\Command;
use InvalidArgumentException;

/**
 * The retention of the live chat (`chat.retention_days`, 0 = keep for ever): deletes closed and missed conversations older than that, with
 * their messages, attachments (the files too) and ratings, then the visitors nothing is left of. Scheduled daily; `--days` runs it once
 * with another value (at least 7). Safe to repeat and to interrupt.
 */
class ChatPruneConversations extends Command
{
    protected $signature = 'chat:prune-conversations
        {--days= : Retention in days for this run (default: the chat.retention_days setting; 0 = nothing; at least 7)}
        {--seconds=240 : Wall-clock budget of the run}';

    protected $description = 'Delete closed conversations (messages, images, ratings) older than the chat retention, and visitors nothing is left of';

    public function handle(PruneConversations $prune): int
    {
        $days = $this->option('days');

        try {
            $result = $prune->handle(is_numeric($days) ? (int) $days : null, max(10, (int) $this->option('seconds')));
        } catch (InvalidArgumentException $exception) {
            $this->components->error($exception->getMessage());

            return self::FAILURE;
        }

        if ($result['retentionDays'] === 0) {
            $this->components->info('Retention is off (chat.retention_days = 0): nothing was deleted.');

            return self::SUCCESS;
        }

        $this->components->info(sprintf(
            'Retention %d day(s): deleted %d conversation(s), %d message(s), %d attachment(s) (%d file(s)) and %d visitor(s); %d skipped%s.',
            $result['retentionDays'], $result['conversations'], $result['messages'], $result['attachments'], $result['files'], $result['visitors'], $result['skipped'], $result['complete'] ? '' : ' (time budget used up: the next run continues)',
        ));

        return $result['skipped'] > 0 ? self::FAILURE : self::SUCCESS;
    }
}
