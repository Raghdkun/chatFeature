<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Enums\ActorType;
use App\Models\Conversation;
use App\Models\ConversationEvent;

/**
 * The append-only audit trail (`conversation_events`) of a conversation: one row per state change, written in the same
 * transaction as the change. Staff-only; never part of a visitor payload.
 */
final class ConversationTimeline
{
    public const CREATED = 'created';

    public const OFFERED = 'offered';

    public const CLAIMED = 'claimed';

    public const TRANSFERRED = 'transferred';

    public const REQUEUED = 'requeued';

    public const ENDED = 'ended';

    public const CLOSED = 'closed';

    public const MISSED = 'missed';

    public const CANCELLED = 'cancelled';

    public const RATED = 'rated';

    /**
     * @param  array<string, mixed>  $payload
     */
    public function record(Conversation|int $conversation, string $type, ?ActorType $actorType = null, ?int $actorId = null, array $payload = []): ConversationEvent
    {
        return ConversationEvent::query()->create([
            'conversation_id' => $conversation instanceof Conversation ? $conversation->id : $conversation,
            'type' => $type,
            'actor_type' => $actorType,
            'actor_id' => $actorId,
            'payload' => $payload === [] ? null : $payload,
        ]);
    }
}
