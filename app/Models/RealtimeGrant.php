<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A staff member was handed a signed subscription to `private-conversation.{ulid}` of this conversation (written by the channel
 * authoriser). The row means "this member's sockets MAY be subscribed": it is what lets a loss of access be turned into a cut-off
 * (`App\Domain\Chat\Realtime\Sockets\ConversationGrants`). Unique per member and conversation; `granted_at` is refreshed on every grant.
 *
 * @property int $id
 * @property int $user_id
 * @property int $conversation_id
 * @property Carbon $granted_at
 * @property-read User $user
 * @property-read Conversation $conversation
 */
#[Fillable(['user_id', 'conversation_id', 'granted_at'])]
class RealtimeGrant extends Model
{
    public $timestamps = false;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'user_id' => 'integer',
            'conversation_id' => 'integer',
            'granted_at' => 'datetime',
        ];
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return BelongsTo<Conversation, $this>
     */
    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }
}
