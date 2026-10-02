<?php

namespace Database\Factories;

use App\Models\PushSubscription;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * A browser subscription with syntactically valid keys (a real P-256 point is not needed unless a test sends to it: tests that do
 * pass `Tests\Support\InteractsWithWebPush::validKeys()`).
 *
 * @extends Factory<PushSubscription>
 */
class PushSubscriptionFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $endpoint = 'https://fcm.googleapis.com/fcm/send/'.Str::random(140);

        return [
            'user_id' => User::factory(),
            'endpoint_hash' => PushSubscription::hashEndpoint($endpoint),
            'endpoint' => $endpoint,
            'p256dh' => rtrim(strtr(base64_encode(random_bytes(65)), '+/', '-_'), '='),
            'auth' => rtrim(strtr(base64_encode(random_bytes(16)), '+/', '-_'), '='),
            'content_encoding' => 'aes128gcm',
            'user_agent' => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'expires_at' => null,
            'last_used_at' => null,
        ];
    }

    public function forEndpoint(string $endpoint): static
    {
        return $this->state(fn (): array => ['endpoint' => $endpoint, 'endpoint_hash' => PushSubscription::hashEndpoint($endpoint)]);
    }
}
