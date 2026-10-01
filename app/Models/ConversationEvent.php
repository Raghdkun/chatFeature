<?php

namespace App\Models;

use App\Domain\Chat\Enums\ActorType;
use Database\Factories\ConversationEventFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * Append-only audit trail of a conversation's state changes (`created`, `offered`, `claimed`, `transferred`, `assigned`,
 * `ended`, `closed`, `missed`, `rated`, ...). Staff-only: never part of a visitor payload.
 *
 * @property int $id
 * @property int $conversation_id
 * @property string $type
 * @property ActorType|null $actor_type
 * @property int|null $actor_id
 * @property array<string, mixed>|null $payload
 * @property Carbon|null $created_at
 * @property-read Conversation $conversation
 */
#[Fillable(['conversation_id', 'type', 'actor_type', 'actor_id', 'payload'])]
class ConversationEvent extends Model
{
    /** @use HasFactory<ConversationEventFactory> */
    use HasFactory;

    public const UPDATED_AT = null;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'conversation_id' => 'integer',
            'actor_type' => ActorType::class,
            'actor_id' => 'integer',
            'payload' => 'array',
        ];
    }

    /**
     * @return BelongsTo<Conversation, $this>
     */
    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }
}
