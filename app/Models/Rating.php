<?php

namespace App\Models;

use Database\Factories\RatingFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * The visitor's 1-5 rating of a finished conversation (one per conversation; the comment is capped at 2000 characters by
 * the request that writes it). Visible to administrators only.
 *
 * @property int $id
 * @property int $conversation_id
 * @property int $score
 * @property string|null $comment
 * @property Carbon|null $created_at
 * @property-read Conversation $conversation
 */
#[Fillable(['conversation_id', 'score', 'comment'])]
class Rating extends Model
{
    /** @use HasFactory<RatingFactory> */
    use HasFactory;

    public const UPDATED_AT = null;

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'conversation_id' => 'integer',
            'score' => 'integer',
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
