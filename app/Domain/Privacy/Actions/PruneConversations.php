<?php

namespace App\Domain\Privacy\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Models\Attachment;
use App\Models\Conversation;
use App\Models\Visitor;
use Carbon\CarbonInterface;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use InvalidArgumentException;
use Throwable;

/**
 * `chat:prune-conversations` (daily): the retention of the live chat (`chat.retention_days`, default 0 = keep for ever). Closed and missed
 * conversations (live chats and offline tickets) whose `closed_at` is older than that many days are deleted with their messages,
 * attachments (the FILES first), ratings, timeline events and offers; then the visitors nothing is left of (no conversation, no session)
 * whose last visit is older than the retention. Open conversations (queued, active, ended and waiting for a rating) are never touched
 * however old they are.
 *
 * Raw rows only: the analytics rollups (`analytics_daily` / `analytics_slots`) hold counts and sums without references, and a day is
 * sealed 3 days after it ends, so a retention of at least `MIN_DAYS` never deletes a conversation that a rollup still has to count. A shorter
 * retention is refused (the setting's rule says the same).
 *
 * A conversation whose file cannot be deleted is skipped (and counted) and tried again the next day: its rows are never removed while
 * files are left behind. Each conversation is its own small delete, in batches, within `$seconds` of wall time, so the run is safe to
 * interrupt and to repeat.
 */
final class PruneConversations
{
    /** Shorter than this and the analytics rollups of those days may not be sealed yet. */
    public const MIN_DAYS = 7;

    private const BATCH = 100;

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  int|null  $days  null = the `chat.retention_days` setting; 0 = nothing
     * @return array{retentionDays: int, conversations: int, messages: int, attachments: int, files: int, visitors: int, skipped: int, complete: bool}
     */
    public function handle(?int $days = null, int $seconds = 240): array
    {
        $days ??= max(0, settings()->int('chat.retention_days', 0));
        $counts = ['conversations' => 0, 'messages' => 0, 'attachments' => 0, 'files' => 0, 'visitors' => 0, 'skipped' => 0];
        $complete = true;

        if ($days === 0) {
            return $this->report(0, $counts, true);
        }

        if ($days < self::MIN_DAYS) {
            throw new InvalidArgumentException('The retention must be 0 (keep) or at least '.self::MIN_DAYS.' days: analytics rollups seal a day 3 days after it ends.');
        }

        $cutoff = now()->subDays($days);
        $deadline = microtime(true) + $seconds;
        $skipped = [];

        do {
            $conversations = Conversation::query()
                ->whereIn('status', [ConversationStatus::Closed->value, ConversationStatus::Missed->value])
                ->where('closed_at', '<', $cutoff)
                ->when($skipped !== [], fn ($query) => $query->whereNotIn('id', $skipped))
                ->orderBy('id')
                ->limit(self::BATCH)
                ->get(['id']);

            foreach ($conversations as $conversation) {
                if (! $this->prune($conversation->id, $counts)) {
                    $skipped[] = $conversation->id;
                    $counts['skipped']++;
                }
            }

            if (microtime(true) > $deadline && $conversations->count() === self::BATCH) {
                $complete = false;

                break;
            }
        } while ($conversations->count() === self::BATCH);

        $counts['visitors'] = $this->visitors($cutoff);

        if ($counts['conversations'] > 0 || $counts['visitors'] > 0) {
            $this->audit->record('conversations.pruned', null, ['retentionDays' => $days] + $counts);
        }

        return $this->report($days, $counts, $complete);
    }

    /**
     * @param  array<string, int>  $counts
     * @return array{retentionDays: int, conversations: int, messages: int, attachments: int, files: int, visitors: int, skipped: int, complete: bool}
     */
    private function report(int $days, array $counts, bool $complete): array
    {
        return [
            'retentionDays' => $days,
            'conversations' => $counts['conversations'],
            'messages' => $counts['messages'],
            'attachments' => $counts['attachments'],
            'files' => $counts['files'],
            'visitors' => $counts['visitors'],
            'skipped' => $counts['skipped'],
            'complete' => $complete,
        ];
    }

    /**
     * @param  array<string, int>  $result
     */
    private function prune(int $conversationId, array &$result): bool
    {
        $attachments = Attachment::query()->where('conversation_id', $conversationId)->get(['id', 'disk', 'path', 'thumb_path']);
        $files = 0;

        try {
            foreach ($attachments as $attachment) {
                $disk = Storage::disk($attachment->disk);

                foreach (array_values(array_filter([$attachment->path, $attachment->thumb_path])) as $path) {
                    $disk->delete($path);

                    if ($disk->exists($path)) {
                        return false;
                    }

                    $files++;
                }
            }
        } catch (Throwable $exception) {
            report($exception);

            return false;
        }

        $messages = DB::table('messages')->where('conversation_id', $conversationId)->count();

        // Messages, attachments, ratings, events and offers cascade; the status guard keeps a conversation that was re-opened meanwhile.
        $deleted = Conversation::query()->whereKey($conversationId)->whereIn('status', [ConversationStatus::Closed->value, ConversationStatus::Missed->value])->delete();

        if ($deleted === 1) {
            $result['conversations']++;
            $result['messages'] += $messages;
            $result['attachments'] += $attachments->count();
            $result['files'] += $files;
        }

        return true;
    }

    /** Visitors nothing is left of: no conversation, no session, last seen before the cut-off (verified ones included: their identity is personal data). */
    private function visitors(CarbonInterface $cutoff): int
    {
        $deleted = 0;

        do {
            $ids = Visitor::query()
                ->where(fn ($query) => $query->whereNull('last_seen_at')->orWhere('last_seen_at', '<', $cutoff))
                ->where('created_at', '<', $cutoff)
                ->whereDoesntHave('conversations')
                ->whereDoesntHave('sessions')
                ->orderBy('id')
                ->limit(500)
                ->pluck('id');
            $count = $ids->isEmpty() ? 0 : Visitor::query()->whereIn('id', $ids)->delete();
            $deleted += $count;
        } while ($count === 500);

        return $deleted;
    }
}
