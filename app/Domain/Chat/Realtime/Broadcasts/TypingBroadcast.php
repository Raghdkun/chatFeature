<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Domain\Chat\Enums\SenderType;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use InvalidArgumentException;

/**
 * The REST fallback of the `client-typing` whisper (`POST …/typing` when a client cannot whisper): the server publishes
 * `typing` `{v, actor: 'visitor'|'agent', typing}` on `private-conversation.{ulid}`, the same fields as the whisper. A server may
 * not publish an event named `client-…`, hence the different name; clients bind both and treat them alike (debounce 3 s,
 * expire 5 s on the receiving side). Dispatch from the typing endpoints after authorising the caller:
 * `TypingBroadcast::dispatch($conversation->ulid, SenderType::Visitor, true)`. Typing is not a message: it never touches the
 * database or the idle timer.
 */
final class TypingBroadcast extends RealtimeBroadcast implements ShouldBroadcastNow
{
    public function __construct(
        public readonly string $conversation,
        public readonly SenderType $actor,
        public readonly bool $typing,
    ) {
        if ($actor === SenderType::System) {
            throw new InvalidArgumentException('Only the visitor and an agent type.');
        }
    }

    public function broadcastAs(): string
    {
        return RealtimeEvent::Typing->value;
    }

    public function broadcastOn(): array
    {
        return [RealtimeChannels::conversation($this->conversation)];
    }

    public function broadcastWith(): array
    {
        return ['v' => 1, 'actor' => $this->actor->value, 'typing' => $this->typing];
    }
}
