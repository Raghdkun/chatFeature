<?php

namespace App\Domain\Notifications\Contracts;

use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;

/**
 * One way of reaching a member of staff's devices: Web Push for browsers (`WebPushChannel`), FCM for a future mobile app (a stub).
 *
 * `deliver()` sends to every target the user has on this channel, in this call, and never throws: whatever goes wrong (the push
 * service is down, a key is bad, the network is cut) comes back in the {@see PushResult}. Callers run it from a queued job, never
 * inside a request that must not fail.
 */
interface PushChannel
{
    /** `web`, `fcm`. */
    public function name(): string;

    /** Whether this channel can send at all (VAPID keys present, FCM switched on). */
    public function isEnabled(): bool;

    /**
     * @param  list<int>|null  $targetIds  Only these rows (subscription / token ids): a retry of what failed the first time.
     * @param  int|null  $timeoutSeconds  Per request; null = the channel's configured timeout.
     * @param  int|null  $deadlineSeconds  For the whole call (every target together): targets not started by then come back as `retry`.
     */
    public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null, ?int $deadlineSeconds = null): PushResult;
}
