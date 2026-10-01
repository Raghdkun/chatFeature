<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use App\Models\ConversationOffer;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A routing wave created these offers (one per eligible agent; all share `wave` and `expiresAt`).
 * Dispatched by the offer action (4A); consumed by 4B: one `chat.offered` per offered agent on `private-staff.{userId}`
 * (payload `OfferData`) plus the web push (P5).
 */
final class ChatOffered implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    /**
     * @param  Collection<int, ConversationOffer>  $offers
     */
    public function __construct(
        public readonly Conversation $conversation,
        public readonly Collection $offers,
        public readonly int $wave,
        public readonly CarbonInterface $expiresAt,
    ) {}
}
