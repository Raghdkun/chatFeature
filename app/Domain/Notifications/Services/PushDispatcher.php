<?php

namespace App\Domain\Notifications\Services;

use App\Domain\Notifications\Contracts\PushChannel;
use App\Domain\Notifications\Jobs\SendPushToUser;
use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;
use Throwable;

/**
 * The single door every push goes through. `queue()` hands a message to a queued job per recipient and never throws (a Redis outage
 * is reported and the request that caused the push carries on); `now()` sends in the caller's process for the one user-initiated case
 * that wants an answer ("Send a test notification").
 */
final class PushDispatcher
{
    /**
     * @param  list<PushChannel>  $channels
     */
    public function __construct(private readonly array $channels) {}

    /**
     * @return list<PushChannel>
     */
    public function channels(): array
    {
        return $this->channels;
    }

    /** Whether any channel can send at all (the VAPID keys exist, or FCM is on). */
    public function isEnabled(): bool
    {
        foreach ($this->channels as $channel) {
            if ($channel->isEnabled()) {
                return true;
            }
        }

        return false;
    }

    /**
     * Queue the message for each user. Returns how many jobs were queued.
     *
     * @param  iterable<int>  $userIds
     */
    public function queue(iterable $userIds, PushMessage $message): int
    {
        $queued = 0;

        foreach ($userIds as $userId) {
            try {
                $job = new SendPushToUser((int) $userId, $message->toArray(), now()->getTimestamp());
                $queue = config('push.queue');

                if (is_string($queue) && $queue !== '') {
                    $job->onQueue($queue);
                }

                dispatch($job);
                $queued++;
            } catch (Throwable $exception) {
                report($exception);
            }
        }

        return $queued;
    }

    /**
     * Send now to every channel; the sum of what they did. `$targetIds` restricts a retry to the rows that failed.
     *
     * @param  list<int>|null  $targetIds
     */
    public function now(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null): PushResult
    {
        $result = PushResult::disabled();

        foreach ($this->channels as $channel) {
            if ($channel->isEnabled()) {
                $result = $result->merge($channel->deliver($userId, $message, $targetIds, $timeoutSeconds));
            }
        }

        return $result;
    }
}
