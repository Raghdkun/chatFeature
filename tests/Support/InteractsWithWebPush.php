<?php

namespace Tests\Support;

use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Minishlink\WebPush\VAPID;
use Tests\TestCase;

/**
 * Web Push in a test: throwaway VAPID keys, subscriptions with keys the push encryption accepts (a real P-256 point), and a fake push
 * service. Nothing leaves the process: `Http::fake` answers every push endpoint of `PUSH_HOST`.
 *
 * @mixin TestCase
 */
trait InteractsWithWebPush
{
    protected const PUSH_HOST = 'fcm.googleapis.com';

    protected string $vapidPublicKey = '';

    /** Configures a fresh VAPID key pair (and turns the feature on). */
    protected function useVapid(): void
    {
        $keys = VAPID::createVapidKeys();
        $this->vapidPublicKey = $keys['publicKey'];

        config([
            'push.vapid.public_key' => $keys['publicKey'],
            'push.vapid.private_key' => $keys['privateKey'],
            'push.vapid.subject' => 'mailto:admin@example.test',
        ]);
    }

    protected function withoutVapid(): void
    {
        config(['push.vapid.public_key' => null, 'push.vapid.private_key' => null]);
    }

    /**
     * Keys a browser would send: a valid uncompressed P-256 public key and a 16-byte auth secret, both base64url.
     *
     * @return array{p256dh: string, auth: string}
     */
    protected function pushKeys(): array
    {
        return [
            'p256dh' => VAPID::createVapidKeys()['publicKey'],
            'auth' => rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '='),
        ];
    }

    /**
     * A stored browser subscription of the user that the push library can really encrypt for.
     *
     * @param  array<string, mixed>  $attributes
     */
    protected function subscribe(User $user, array $attributes = []): PushSubscription
    {
        return PushSubscription::factory()->create($this->pushKeys() + ['user_id' => $user->id] + $attributes);
    }

    /** Every request to the fake push service answers with `$status` (201 = accepted). */
    protected function fakePushService(int $status = 201): void
    {
        Http::fake(['https://'.self::PUSH_HOST.'/*' => Http::response('', $status)]);
    }

    /**
     * The requests the fake push service received.
     *
     * @return list<Request>
     */
    protected function pushRequests(): array
    {
        return array_values(array_map(fn (array $pair): Request => $pair[0], Http::recorded(fn (Request $request): bool => str_contains($request->url(), self::PUSH_HOST))->all()));
    }
}
