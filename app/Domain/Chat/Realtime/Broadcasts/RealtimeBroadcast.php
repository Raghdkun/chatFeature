<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcast;
use Illuminate\Contracts\Broadcasting\ShouldRescue;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * Base of every server event of docs/contracts/realtime-events.md. Queued by default (`ShouldBroadcast`); the few events whose
 * latency matters extend `ImmediatePayloadBroadcast` (`ShouldBroadcastNow`).
 *
 * `ShouldRescue` is what keeps the chat alive when Reverb or the queue is down: the framework then reports the failure and goes
 * on instead of throwing into the request that stored the message. A queued broadcast gives up after three tries a second apart:
 * a live event that arrives half a minute late is worse than none (clients resync over REST on reconnect).
 *
 * Subclasses keep only scalars in public properties (the object is serialised onto the queue) and build their payload from the
 * spine's `App\Data\Chat\*` classes, so every payload carries `v: 1` and nothing the contract does not list.
 */
abstract class RealtimeBroadcast implements ShouldBroadcast, ShouldRescue
{
    use Dispatchable;

    public int $tries = 3;

    public int $timeout = 10;

    public int $backoff = 1;

    /** The event name (`broadcastAs()`), e.g. `chat.offered`. */
    abstract public function broadcastAs(): string;

    /**
     * @return array<int, Channel>
     */
    abstract public function broadcastOn(): array;

    /**
     * @return array<string, mixed>
     */
    abstract public function broadcastWith(): array;

    /** `REALTIME_QUEUE`; null = the default queue (the dev runner and a plain worker both handle it). */
    public function broadcastQueue(): ?string
    {
        $queue = config('broadcasting.realtime.queue');

        return is_string($queue) && $queue !== '' ? $queue : null;
    }
}
