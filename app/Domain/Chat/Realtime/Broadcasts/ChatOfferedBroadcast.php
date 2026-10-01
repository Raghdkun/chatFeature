<?php

namespace App\Domain\Chat\Realtime\Broadcasts;

use App\Data\Chat\OfferData;
use App\Domain\Chat\Realtime\RealtimeChannels;
use App\Domain\Chat\Realtime\RealtimeEvent;
use App\Domain\Chat\Realtime\Support\ActiveStaff;
use App\Models\ConversationOffer;
use Carbon\CarbonImmutable;

/**
 * `chat.offered` to `private-staff.{id}` of every agent of one routing wave. All offers of a wave share `wave` and the deadline,
 * so one payload (`OfferData`, built by the spine's own mapping) goes to all of them.
 */
final class ChatOfferedBroadcast extends ConversationBroadcast
{
    /**
     * @param  list<int>  $userIds
     */
    public function __construct(string $conversation, public readonly array $userIds, public readonly int $wave, public readonly int $expiresAt)
    {
        parent::__construct($conversation);
    }

    public function broadcastAs(): string
    {
        return RealtimeEvent::ChatOffered->value;
    }

    public function broadcastOn(): array
    {
        return $this->load() === null ? [] : RealtimeChannels::staffMany(ActiveStaff::only($this->userIds));
    }

    public function broadcastWith(): array
    {
        $offer = new ConversationOffer(['wave' => $this->wave, 'expires_at' => CarbonImmutable::createFromTimestamp($this->expiresAt)]);

        return OfferData::fromModel($this->loadOrFail(), $offer)->toArray();
    }
}
