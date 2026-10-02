<?php

namespace App\Domain\Notifications\Jobs;

use App\Domain\Notifications\Enums\PushType;
use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushOfferState;
use App\Domain\Notifications\Support\PushMessage;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\Jobs\SyncJob;
use Throwable;

/**
 * Sends one push to every device of one user (decision P5-D4: everything is queued). A target that failed in a way worth retrying
 * (a push service that timed out or answered 5xx, or that the job's time budget did not reach) is retried by a NEW job that carries only
 * those targets, after the configured pause, up to `push.job.tries` attempts: a device that already got the message is not pushed twice.
 * A push that outlived its TTL is dropped (an offer the agent can no longer accept must not ring), and so is an `offer` whose chat was
 * taken, cancelled or expired while the job waited in the queue ({@see PushOfferState}; when it closes DURING the send, a silent dismiss
 * follows at once). Nothing here ever throws: a failed push is logged, not retried by the queue, and never touches the request that
 * caused it.
 *
 * One job has a total time budget (`push.job.deadline_seconds`) across all the devices of the member, each device still has its own
 * timeout. On the `sync` queue no retry is scheduled: the pause would be ignored and the retries would run nested, back to back.
 */
final class SendPushToUser implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    /** The queue never retries this job itself: a retry is a new job with the failed targets only. */
    public int $tries = 1;

    /** Seconds the worker lets the job run: its own deadline plus a margin (set in the constructor). */
    public int $timeout = 90;

    /**
     * @param  array<string, mixed>  $message  `PushMessage::toArray()`
     * @param  list<int>|null  $targetIds
     */
    public function __construct(
        public readonly int $userId,
        public readonly array $message,
        public readonly int $queuedAt,
        public readonly ?array $targetIds = null,
        public readonly int $attempt = 1,
    ) {
        $this->timeout = $this->deadlineSeconds() + 30;
    }

    public function handle(PushDispatcher $push): void
    {
        try {
            $message = PushMessage::fromArray($this->message);

            if (now()->getTimestamp() >= $this->queuedAt + max(1, $message->ttl)) {
                return;
            }

            $offers = app(PushOfferState::class);

            if ($message->type === PushType::Offer && ! $offers->isOpenFor($message->tag, $this->userId)) {
                return;
            }

            $result = $push->now($this->userId, $message, $this->targetIds, null, $this->deadlineSeconds());

            if ($message->type === PushType::Offer && $result->sent > 0 && ! $offers->isOpenFor($message->tag, $this->userId)) {
                // It closed while the push was on its way: the dismiss that ran in between may not have found this device.
                $push->queue([$this->userId], PushMessage::dismiss($message->tag));
            }

            if ($result->retry !== [] && $this->attempt < (int) config('push.job.tries', 3) && ! $this->runsOnSyncQueue()) {
                $this->retry($result->retry);
            }
        } catch (Throwable $exception) {
            report($exception);
        }
    }

    public function failed(?Throwable $exception): void
    {
        if ($exception !== null) {
            report($exception);
        }
    }

    private function deadlineSeconds(): int
    {
        return max(5, (int) config('push.job.deadline_seconds', 60));
    }

    /** The `sync` queue runs a "delayed" job at once: retrying there would loop back to back inside the request that caused the push. */
    private function runsOnSyncQueue(): bool
    {
        if ($this->job instanceof SyncJob) {
            return true;
        }

        $connection = $this->connection ?? config('queue.default');

        return config('queue.connections.'.$connection.'.driver') === 'sync';
    }

    /**
     * @param  list<int>  $targetIds
     */
    private function retry(array $targetIds): void
    {
        $pauses = array_values(array_filter((array) config('push.job.backoff', [5, 30]), 'is_int'));
        $pause = $pauses[min($this->attempt - 1, max(0, count($pauses) - 1))] ?? 5;

        $next = new self($this->userId, $this->message, $this->queuedAt, $targetIds, $this->attempt + 1);
        $queue = config('push.queue');

        if (is_string($queue) && $queue !== '') {
            $next->onQueue($queue);
        }

        dispatch($next->delay($pause));
    }
}
