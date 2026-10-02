<?php

namespace App\Domain\Notifications\Channels;

use App\Domain\Notifications\Contracts\PushChannel;
use App\Domain\Notifications\Support\PushMessage;
use App\Domain\Notifications\Support\PushResult;
use App\Models\DeviceToken;
use Illuminate\Support\Facades\Log;

/**
 * Firebase Cloud Messaging for the future mobile app: a STUB (decision P5-D4). While `push.fcm.enabled` is false (the default) it does
 * nothing; switched on it still only logs what it would send. It never opens a connection and never reads or logs a token.
 */
final class FcmChannel implements PushChannel
{
    public function name(): string
    {
        return 'fcm';
    }

    public function isEnabled(): bool
    {
        return (bool) config('push.fcm.enabled', false);
    }

    public function deliver(int $userId, PushMessage $message, ?array $targetIds = null, ?int $timeoutSeconds = null): PushResult
    {
        if (! $this->isEnabled()) {
            return PushResult::disabled();
        }

        $tokens = DeviceToken::query()->ownedBy($userId)->when($targetIds !== null, fn ($query) => $query->whereKey($targetIds))->count();

        Log::info('push.fcm.stub', ['user' => $userId, 'type' => $message->type->value, 'tag' => $message->tag, 'devices' => $tokens]);

        return PushResult::disabled();
    }
}
