<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\Events\OfflineTicketCreatedPayload;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;

/** `offline-ticket.created` on `private-admin`: `{v, conversation: ConversationStaff}`. */
final class OfflineTicketCreatedBroadcast extends ConversationBroadcast
{
    public function broadcastAs(): string
    {
        return RealtimeEvent::OfflineTicketCreated->value;
    }

    public function broadcastOn(): array
    {
        return $this->load() === null ? [] : [RealtimeChannels::admin()];
    }

    public function broadcastWith(): array
    {
        return (new OfflineTicketCreatedPayload(ConversationStaffData::fromModel($this->loadOrFail())))->toArray();
    }
}
