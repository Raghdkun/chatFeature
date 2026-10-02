<?php

namespace App\Data\Notifications;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\DeviceToken;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A registered mobile device (the FCM stub): the token itself is never returned. */
#[TypeScript]
class DeviceTokenData extends Data
{
    public function __construct(
        public string $id,
        public string $platform,
        public ?string $lastSeenAt,
    ) {}

    public static function fromModel(DeviceToken $device): self
    {
        return new self($device->ulid, $device->platform, Timestamps::iso($device->last_seen_at));
    }
}
