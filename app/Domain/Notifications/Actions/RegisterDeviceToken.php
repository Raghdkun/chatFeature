<?php

namespace App\Domain\Notifications\Actions;

use App\Models\DeviceToken;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Stores a mobile device's FCM token (`POST /me/devices`): a stub for the future mobile app (decision P5-D4), nothing is sent to it yet.
 * An upsert by the token's hash; a token another member of staff had registered moves to the caller (the phone is theirs now). A user
 * keeps at most `push.max_devices_per_user` devices.
 */
final class RegisterDeviceToken
{
    public function handle(User $user, string $platform, #[\SensitiveParameter] string $token): DeviceToken
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                // The same first-registration deadlock as a push subscription (a SELECT ... FOR UPDATE on a row that does not exist yet): run again.
                return DeadlockRetry::transaction(fn (): DeviceToken => $this->upsert($user, $platform, $token));
            } catch (UniqueConstraintViolationException $exception) {
                if ($attempt >= 2) {
                    throw $exception;
                }
            }
        }
    }

    private function upsert(User $user, string $platform, #[\SensitiveParameter] string $token): DeviceToken
    {
        $hash = DeviceToken::hashToken($token);
        $device = DeviceToken::query()->where('token_hash', $hash)->lockForUpdate()->first() ?? new DeviceToken;

        $device->fill(['user_id' => $user->id, 'platform' => $platform, 'token_hash' => $hash, 'token' => $token, 'last_seen_at' => now()])->save();

        $max = max(1, (int) config('push.max_devices_per_user', 10));
        $stale = DeviceToken::query()->ownedBy($user)->whereKeyNot($device->id)->orderByDesc('last_seen_at')->orderByDesc('id')->pluck('id');

        if ($stale->count() >= $max) {
            DeviceToken::query()->whereKey($stale->slice($max - 1)->all())->delete();
        }

        return $device;
    }
}
