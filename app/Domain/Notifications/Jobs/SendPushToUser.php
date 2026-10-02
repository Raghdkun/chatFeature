<?php

namespace App\Domain\Notifications\Jobs;

use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Support\PushMessage;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Throwable;

/**
 * Sends one push to every device of one user (decision P5-D4: everything is queued). A target that failed in a way worth retrying
 * (a push service that timed out or answered 5xx) is retried by a NEW job that carries only those targets, after the configured pause,
 * up to `push.job.tries` attempts: a device that already got the message is not pushed twice. A push that outlived its TTL is dropped
 * (an offer the agent can no longer accept must not ring), and nothing here ever throws: a failed push is logged, not retried by the
 * queue, and never touches the request that caused it.
 */
final class SendPushToUser implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable;

    /** The queue never retries this job itself: a retry is a new job with the failed targets only. */
    public int $tries = 1;

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
    ) {}

    public function handle(PushDispatcher $push): void
    {
        try {
            $message = PushMessage::fromArray($this->message);

            if (now()->getTimestamp() >= $this->queuedAt + max(1, $message->ttl)) {
                return;
            }

            $result = $push->now($this->userId, $message, $this->targetIds);

            if ($result->retry !== [] && $this->attempt < (int) config('push.job.tries', 3)) {
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
