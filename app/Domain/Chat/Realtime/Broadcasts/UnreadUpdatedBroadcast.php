<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Data\Chat\Events\UnreadUpdatedPayload;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Chat\Realtime\Support\ActiveStaff;

/** `unread.updated` to the assigned agent: the server's absolute counter (never a delta), read when the worker runs. */
final class UnreadUpdatedBroadcast extends ConversationBroadcast
{
    public function broadcastAs(): string
    {
        return RealtimeEvent::UnreadUpdated->value;
    }

    public function broadcastOn(): array
    {
        $agentId = $this->load()?->assigned_agent_id;

        return $agentId === null ? [] : RealtimeChannels::staffMany(ActiveStaff::only([$agentId]));
    }

    public function broadcastWith(): array
    {
        $conversation = $this->loadOrFail();

        return (new UnreadUpdatedPayload($conversation->ulid, $conversation->unseen_by_agent))->toArray();
    }
}
