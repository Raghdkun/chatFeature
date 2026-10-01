<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Data\Chat\ConversationStaffData;
use App\Data\Chat\Events\ConversationUpdatedPayload;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Chat\Realtime\Support\ConversationAudience;

/**
 * `conversation.updated`: the staff view of a conversation for list refreshes, to everybody who can see it (assigned agent, open
 * offers, category servers of an offline ticket: `ConversationAudience`), to `private-admin` and to `$alsoStaff` (the agent a chat
 * was just taken from).
 */
final class ConversationUpdatedBroadcast extends ConversationBroadcast
{
    /**
     * @param  list<int>  $alsoStaff
     */
    public function __construct(string $conversation, public readonly array $alsoStaff = [], public readonly bool $toAdmin = true)
    {
        parent::__construct($conversation);
    }

    public function broadcastAs(): string
    {
        return RealtimeEvent::ConversationUpdated->value;
    }

    public function broadcastOn(): array
    {
        $conversation = $this->load();

        if ($conversation === null) {
            return [];
        }

        $channels = $this->toAdmin ? [RealtimeChannels::admin()] : [];

        return [...$channels, ...RealtimeChannels::staffMany(app(ConversationAudience::class)->staffIds($conversation, $this->alsoStaff))];
    }

    public function broadcastWith(): array
    {
        return (new ConversationUpdatedPayload(ConversationStaffData::fromModel($this->loadOrFail())))->toArray();
    }
}
