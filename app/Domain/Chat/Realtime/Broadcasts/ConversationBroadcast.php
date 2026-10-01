<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Models\Conversation;

/**
 * An event that describes the CURRENT state of one conversation (`conversation.updated`, `chat.offered`, `unread.updated`,
 * `offline-ticket.created`). It carries only the conversation's ulid: channels and payload are read when the queue worker
 * handles it, so events handled out of order or late still say what is true now, and a conversation that is gone by then is
 * simply not broadcast (no channels). The loaded model lives in a private property that is only set inside the worker.
 */
abstract class ConversationBroadcast extends RealtimeBroadcast
{
    private ?Conversation $loaded = null;

    private bool $resolved = false;

    public function __construct(public readonly string $conversation) {}

    /** The conversation with everything the staff payloads need, or null when it no longer exists. */
    protected function load(): ?Conversation
    {
        if (! $this->resolved) {
            $this->loaded = Conversation::query()
                ->with(['category', 'assignedAgent', 'visitor', 'widget'])
                ->where('ulid', $this->conversation)
                ->first();
            $this->resolved = true;
        }

        return $this->loaded;
    }

    protected function loadOrFail(): Conversation
    {
        return $this->load() ?? throw new \LogicException('The conversation '.$this->conversation.' was not found.');
    }
}
