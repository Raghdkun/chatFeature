<?php

namespace App\Models;

use App\Domain\Chat\Enums\OfferResponse;
use Database\Factories\ConversationOfferFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * An offer of a queued chat to one agent (table `conversation_agent_alerts`, unique per conversation + agent).
 * "Open" = not answered and not expired yet: that is what lets the agent see and claim a queued chat.
 *
 * @property int $id
 * @property int $conversation_id
 * @property int $user_id
 * @property int $wave
 * @property Carbon $offered_at
 * @property Carbon $expires_at
 * @property Carbon|null $responded_at
 * @property OfferResponse|null $response
 * @property-read Conversation $conversation
 * @property-read User $user
 */
#[Fillable(['conversation_id', 'user_id', 'wave', 'offered_at', 'expires_at', 'responded_at', 'response'])]
class ConversationOffer extends Model
{
    /** @use HasFactory<ConversationOfferFactory> */
    use HasFactory;

    protected $table = 'conversation_agent_alerts';

    public $timestamps = false;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'conversation_id' => 'integer',
            'user_id' => 'integer',
            'wave' => 'integer',
            'offered_at' => 'datetime',
            'expires_at' => 'datetime',
            'responded_at' => 'datetime',
            'response' => OfferResponse::class,
        ];
    }

    /**
     * @return BelongsTo<Conversation, $this>
     */
    public function conversation(): BelongsTo
    {
        return $this->belongsTo(Conversation::class);
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /** Whether the agent can still act on this offer. */
    public function isOpen(): bool
    {
        return $this->responded_at === null && $this->expires_at->isFuture();
    }

    /**
     * Offers that are neither answered nor expired.
     *
     * @param  Builder<ConversationOffer>  $query
     * @return Builder<ConversationOffer>
     */
    public function scopeOpen(Builder $query): Builder
    {
        return $query->whereNull($query->qualifyColumn('responded_at'))->where($query->qualifyColumn('expires_at'), '>', now());
    }
}
