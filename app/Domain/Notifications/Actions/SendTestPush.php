<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushMessages;
use App\Models\PushSubscription;
use App\Models\User;

/**
 * "Send a test notification" (`POST /me/push-subscriptions/test`): a real push to the caller's own browsers, sent right away so the
 * answer says what the push services did. The request is bounded three ways: a short timeout per device, at most
 * `push.test.max_devices` devices (the most recently used first) and `push.test.deadline_seconds` (never more than 10) for all of them
 * TOGETHER, so a member with many dead subscriptions cannot hold a PHP worker; the endpoint is rate limited too. Devices the deadline
 * did not reach count as failed.
 */
final class SendTestPush
{
    /** Seconds one push service may take. */
    private const TIMEOUT_SECONDS = 5;

    /** The ceiling of the deadline whatever the configuration says. */
    private const MAX_DEADLINE_SECONDS = 10;

    public function __construct(
        private readonly PushDispatcher $push,
        private readonly PushMessages $messages,
    ) {}

    /**
     * @return array{devices: int, sent: int, failed: int, removed: int}
     */
    public function handle(User $user): array
    {
        $ids = array_values(array_map(intval(...), PushSubscription::query()
            ->ownedBy($user)
            ->orderByRaw('COALESCE(last_used_at, created_at) DESC')
            ->orderByDesc('id')
            ->limit(max(1, (int) config('push.test.max_devices', 5)))
            ->pluck('id')
            ->all()));

        $deadline = max(1, min(self::MAX_DEADLINE_SECONDS, (int) config('push.test.deadline_seconds', self::MAX_DEADLINE_SECONDS)));
        $result = $this->push->now($user->id, $this->messages->test($user), $ids, self::TIMEOUT_SECONDS, $deadline);

        return [
            'devices' => count($ids),
            'sent' => $result->sent,
            'failed' => $result->failed + count($result->retry),
            'removed' => $result->pruned,
        ];
    }
}
