<?php

namespace App\Domain\Notifications\Actions;

use App\Models\PushSubscription;
use App\Models\User;
use App\Support\Database\DeadlockRetry;
use Carbon\CarbonImmutable;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Registers the browser's push subscription for the signed-in user (`POST /me/push-subscriptions`), an upsert by the hash of the
 * endpoint: the same browser registering again refreshes its keys instead of adding a row, and a browser that a different member of
 * staff signs in to is handed over to them (the device now belongs to the person using it). A user keeps at most
 * `push.max_subscriptions_per_user` browsers: the least recently used are dropped beyond that. The web session that registered it is
 * remembered (hashed) so that signing out can take the browser's subscription with it (`ForgetSessionPushSubscriptions`).
 */
final class StorePushSubscription
{
    /**
     * @param  array{endpoint: string, p256dh: string, auth: string, content_encoding?: string, expiration_time?: int|float|null}  $data
     * @return array{0: PushSubscription, 1: bool} the row and whether it is new
     */
    public function handle(User $user, array $data, ?string $userAgent, ?string $sessionId = null): array
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                // Two browsers registering for the first time lock the gap of the unique `endpoint_hash` index and one INSERT is chosen as the
                // deadlock victim (MySQL 1213, a 500 found by the e2e suite): the transaction runs again.
                return DeadlockRetry::transaction(fn (): array => $this->upsert($user, $data, $userAgent, $sessionId));
            } catch (UniqueConstraintViolationException $exception) {
                // Two first registrations of one endpoint raced for its unique row: the second now finds it and updates it. (The `FOR UPDATE`
                // read of a row that does not exist yet takes a gap lock, so on MySQL the loser can also be a deadlock victim:
                // `DeadlockRetry` runs it again.)
                if ($attempt >= 2) {
                    throw $exception;
                }
            }
        }
    }

    /**
     * @param  array{endpoint: string, p256dh: string, auth: string, content_encoding?: string, expiration_time?: int|float|null}  $data
     * @return array{0: PushSubscription, 1: bool}
     */
    private function upsert(User $user, array $data, ?string $userAgent, ?string $sessionId): array
    {
        $hash = PushSubscription::hashEndpoint($data['endpoint']);
        $subscription = PushSubscription::query()->where('endpoint_hash', $hash)->lockForUpdate()->first();
        $created = $subscription === null;
        $subscription ??= new PushSubscription;

        $subscription->fill([
            'user_id' => $user->id,
            'endpoint_hash' => $hash,
            'endpoint' => $data['endpoint'],
            'p256dh' => $data['p256dh'],
            'auth' => $data['auth'],
            'content_encoding' => $data['content_encoding'] ?? 'aes128gcm',
            'user_agent' => $userAgent === null ? null : mb_substr($userAgent, 0, 255),
            'session_hash' => $sessionId === null || $sessionId === '' ? null : PushSubscription::hashSession($sessionId),
            'expires_at' => $this->expiry($data['expiration_time'] ?? null),
        ])->save();

        $this->trim($user, $subscription);

        return [$subscription, $created];
    }

    /** The browser reports `expirationTime` in milliseconds since the epoch (null: it does not expire). */
    private function expiry(int|float|null $milliseconds): ?CarbonImmutable
    {
        return $milliseconds === null || $milliseconds <= 0 ? null : CarbonImmutable::createFromTimestampMs((int) $milliseconds);
    }

    private function trim(User $user, PushSubscription $keep): void
    {
        $max = max(1, (int) config('push.max_subscriptions_per_user', 10));
        $ids = PushSubscription::query()
            ->ownedBy($user)
            ->whereKeyNot($keep->id)
            ->orderByRaw('COALESCE(last_used_at, created_at) DESC')
            ->orderByDesc('id')
            ->pluck('id');

        if ($ids->count() >= $max) {
            PushSubscription::query()->whereKey($ids->slice($max - 1)->all())->delete();
        }
    }
}
