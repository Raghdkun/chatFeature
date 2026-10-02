<?php

namespace App\Data\Notifications;

use App\Domain\Notifications\Support\DeviceLabel;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\PushSubscription;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A browser that receives pushes (`/me/push-subscriptions`). The endpoint and keys never leave the server: `host` names the push
 * service, and `endpointHash` (sha256 of the endpoint) lets the browser recognise its own row ("This device") by hashing its endpoint.
 */
#[TypeScript]
class PushSubscriptionData extends Data
{
    public function __construct(
        public string $id,
        public string $label,
        public ?string $userAgent,
        public string $host,
        public string $endpointHash,
        public ?string $createdAt,
        public ?string $lastUsedAt,
        public ?string $expiresAt,
    ) {}

    public static function fromModel(PushSubscription $subscription): self
    {
        return new self(
            id: $subscription->ulid,
            label: DeviceLabel::fromUserAgent($subscription->user_agent),
            userAgent: $subscription->user_agent,
            host: $subscription->endpointHost(),
            endpointHash: $subscription->endpoint_hash,
            createdAt: Timestamps::iso($subscription->created_at),
            lastUsedAt: Timestamps::iso($subscription->last_used_at),
            expiresAt: Timestamps::iso($subscription->expires_at),
        );
    }
}
