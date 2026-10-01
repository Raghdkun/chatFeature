<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use App\Models\Rating;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * The visitor rated the conversation. Dispatched by the rating action (4A); consumed by 4B: `conversation.rated` on
 * `private-admin` (`ConversationRatedPayload`) and by analytics (P7).
 */
final class ConversationRated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly Rating $rating,
    ) {}
}
