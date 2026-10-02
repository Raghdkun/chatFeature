<?php

namespace App\Domain\Notifications\Actions;

use App\Domain\Notifications\Services\PushDispatcher;
use App\Domain\Notifications\Services\PushMessages;
use App\Models\PushSubscription;
use App\Models\User;

/**
 * "Send a test notification" (`POST /me/push-subscriptions/test`): a real push to the caller's own browsers, sent right away so the
 * answer says what the push services did. A short timeout per device keeps the request bounded; the endpoint is rate limited.
 */
final class SendTestPush
{
    /** Seconds one push service may take; at most `push.max_subscriptions_per_user` of them are tried one after the other. */
    private const TIMEOUT_SECONDS = 5;

    public function __construct(
        private readonly PushDispatcher $push,
        private readonly PushMessages $messages,
    ) {}

    /**
     * @return array{devices: int, sent: int, failed: int, removed: int}
     */
    public function handle(User $user): array
    {
        $devices = PushSubscription::query()->ownedBy($user)->count();
        $result = $this->push->now($user->id, $this->messages->test($user), timeoutSeconds: self::TIMEOUT_SECONDS);

        return [
            'devices' => $devices,
            'sent' => $result->sent,
            'failed' => $result->failed + count($result->retry),
            'removed' => $result->pruned,
        ];
    }
}
