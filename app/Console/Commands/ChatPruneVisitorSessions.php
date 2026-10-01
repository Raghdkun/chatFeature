<?php

namespace App\Console\Commands;

use App\Domain\Visitors\Actions\PruneVisitorSessions;
use Illuminate\Console\Command;

/**
 * Housekeeping: deletes visitor sessions that expired or were revoked a while ago, anonymous visitors left with nothing,
 * and uploaded images no message ever referenced (files included). Scheduled daily.
 */
class ChatPruneVisitorSessions extends Command
{
    protected $signature = 'chat:prune-visitor-sessions
        {--session-days=7 : How long expired or revoked sessions are kept}
        {--attachment-hours=24 : How long an unreferenced upload is kept}';

    protected $description = 'Delete old visitor sessions, orphan visitors and unreferenced attachments';

    public function handle(PruneVisitorSessions $prune): int
    {
        $result = $prune->handle(max(0, (int) $this->option('session-days')), max(0, (int) $this->option('attachment-hours')));

        $this->components->info("Deleted {$result['sessions']} session(s), {$result['visitors']} visitor(s) and {$result['attachments']} attachment(s).");

        return self::SUCCESS;
    }
}
