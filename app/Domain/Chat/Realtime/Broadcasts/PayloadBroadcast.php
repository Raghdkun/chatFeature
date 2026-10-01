<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Domain\Chat\Realtime\RealtimeEvent;
use Illuminate\Broadcasting\Channel;

/**
 * An event whose channels and payload are fully known when it is dispatched (a fact: "agent X took the chat"), queued.
 * The payload is the `toArray()` of one of the spine's payload classes.
 */
class PayloadBroadcast extends RealtimeBroadcast
{
    /**
     * @param  list<Channel>  $channels
     * @param  array<string, mixed>  $payload
     */
    public function __construct(
        public readonly RealtimeEvent $name,
        public readonly array $channels,
        public readonly array $payload,
    ) {}

    public function broadcastAs(): string
    {
        return $this->name->value;
    }

    public function broadcastOn(): array
    {
        return $this->channels;
    }

    public function broadcastWith(): array
    {
        return $this->payload;
    }
}
