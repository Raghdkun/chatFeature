<?php

namespace App\Domain\WhatsApp\Realtime;

use App\Domain\Chat\Realtime\Broadcasts\RealtimeBroadcast;
use App\Domain\WhatsApp\Enums\WaRealtimeEvent;
use App\Domain\WhatsApp\Support\WhatsAppRealtime;
use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;

/**
 * One event of the admin-only channel `private-whatsapp-admin` (decision P6-D8): the name is a {@see WaRealtimeEvent}, the payload the
 * `toArray()` of one of the spine's payload classes (every one starts with `v: 1`). Published from the process that raised it
 * (`ShouldBroadcastNow`): the volume is an administrator's inbox, the latency is the point, and `RealtimeBroadcast` is `ShouldRescue`, so
 * a Reverb that is down is reported and never breaks the webhook or the request that caused the event.
 */
final class WaPayloadBroadcast extends RealtimeBroadcast implements ShouldBroadcastNow
{
    /**
     * @param  array<string, mixed>  $payload
     */
    public function __construct(
        public readonly WaRealtimeEvent $name,
        public readonly array $payload,
    ) {}

    public function broadcastAs(): string
    {
        return $this->name->value;
    }

    /**
     * @return array<int, Channel>
     */
    public function broadcastOn(): array
    {
        return [WhatsAppRealtime::adminChannel()];
    }

    /**
     * @return array<string, mixed>
     */
    public function broadcastWith(): array
    {
        return $this->payload;
    }
}
