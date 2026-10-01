<?php

namespace App\Domain\Visitors\Actions;

use App\Models\Attachment;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Support\Facades\Storage;

/**
 * Housekeeping (`chat:prune-visitor-sessions`, daily): sessions that expired or were revoked more than `$sessionGraceDays` ago
 * (their conversations stay, detached), anonymous visitors left with neither a session nor a conversation, and attachments nobody
 * referenced for `$attachmentGraceHours` (the file and its thumbnail go too).
 */
final class PruneVisitorSessions
{
    /**
     * @return array{sessions: int, visitors: int, attachments: int}
     */
    public function handle(int $sessionGraceDays = 7, int $attachmentGraceHours = 24): array
    {
        $sessionCutoff = now()->subDays(max(0, $sessionGraceDays));

        $sessions = VisitorSession::query()
            ->where(fn ($query) => $query->where('expires_at', '<', $sessionCutoff)->orWhere('revoked_at', '<', $sessionCutoff))
            ->delete();

        $visitors = Visitor::query()
            ->where('verified', false)
            ->where('created_at', '<', $sessionCutoff)
            ->whereDoesntHave('sessions')
            ->whereDoesntHave('conversations')
            ->delete();

        return ['sessions' => $sessions, 'visitors' => $visitors, 'attachments' => $this->pruneAttachments($attachmentGraceHours)];
    }

    private function pruneAttachments(int $graceHours): int
    {
        $pruned = 0;

        Attachment::query()
            ->whereNull('message_id')
            ->where('created_at', '<', now()->subHours(max(0, $graceHours)))
            ->chunkById(200, function ($attachments) use (&$pruned): void {
                foreach ($attachments as $attachment) {
                    Storage::disk($attachment->disk)->delete(array_values(array_filter([$attachment->path, $attachment->thumb_path])));
                    $attachment->delete();
                    $pruned++;
                }
            });

        return $pruned;
    }
}
