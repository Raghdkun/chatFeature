<?php

namespace App\Domain\Notifications\Services;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Models\Conversation;
use App\Models\ConversationOffer;

/**
 * Is an offer still worth ringing for? Asked by the push job itself, right before it sends an `offer` and again right after: a push is
 * queued first and runs later (workers, the queue's own backlog), so the chat may have been taken, cancelled by the visitor or have
 * expired in between. The answer is the offer's own state (the conversation still waiting, THIS agent's offer open), which is what the
 * silent dismiss reacts to as well: a dismiss that was recorded before its offer job ran therefore also drops that offer.
 */
final class PushOfferState
{
    /** True when the tag is not an offer's (not ours to judge) or the offer is still open for this user. */
    public function isOpenFor(string $tag, int $userId): bool
    {
        $ulid = PushMessages::conversationOfOfferTag($tag);

        if ($ulid === null) {
            return true;
        }

        $conversation = Conversation::query()->where('ulid', $ulid)->first(['id', 'status']);

        if ($conversation === null || $conversation->status !== ConversationStatus::Queued) {
            return false;
        }

        return ConversationOffer::query()->where('conversation_id', $conversation->id)->where('user_id', $userId)->open()->exists();
    }
}
