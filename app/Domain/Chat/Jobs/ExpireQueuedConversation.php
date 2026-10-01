<?php

namespace App\Domain\Chat\Jobs;

use App\Domain\Chat\Actions\ExpireQueuedConversations;
use App\Models\Conversation;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;

/**
 * Marks one queued live chat `missed` once its queue timeout has passed (dispatched with a delay when the chat is queued; the
 * per-minute `chat:expire-queued` sweep catches anything this misses). It does nothing when the chat was claimed, cancelled or
 * moved in the meantime, or when its deadline has not been reached (a sync queue runs delayed jobs at once).
 */
final class ExpireQueuedConversation implements ShouldQueue
{
    use Queueable;

    public function __construct(public readonly int $conversationId) {}

    /**
     * Seconds the job waits beyond the deadline: the stored deadline has whole-second precision, and the job must not find the chat
     * a moment too early (the sweep would then take it a minute later).
     */
    public const MARGIN_SECONDS = 2;

    /** Queue the expiry for the moment the conversation's queue deadline passes. */
    public static function schedule(Conversation $conversation): void
    {
        if ($conversation->queue_expires_at === null) {
            return;
        }

        $delay = max(0, (int) ceil(now()->diffInSeconds($conversation->queue_expires_at, false)));

        self::dispatch($conversation->id)->delay($delay + self::MARGIN_SECONDS)->afterCommit();
    }

    public function handle(ExpireQueuedConversations $expire): void
    {
        $expire->expire($this->conversationId);
    }
}
