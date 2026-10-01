<?php

namespace App\Models;

use App\Domain\Chat\Enums\MessageType;
use App\Domain\Chat\Enums\SenderType;
use Database\Factories\MessageFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * One chat message. Ordered by `seq` (unique per conversation), idempotent by `client_msg_id`. Immutable once written
 * apart from the receipt timestamps (`delivered_at`, `seen_at`). Plain text only: every client renders `body` as text.
 *
 * @property int $id
 * @property string $ulid
 * @property int $conversation_id
 * @property int $seq
 * @property SenderType $sender_type
 * @property int|null $sender_user_id
 * @property MessageType $type
 * @property string|null $body
 * @property string|null $client_msg_id
 * @property Carbon|null $delivered_at
 * @property Carbon|null $seen_at
 * @property Carbon|null $created_at
 * @property-read Conversation $conversation
 * @property-read User|null $senderUser
 */
#[Fillable(['conversation_id', 'seq', 'sender_type', 'sender_user_id', 'type', 'body', 'client_msg_id', 'delivered_at', 'seen_at'])]
class Message extends Model
{
    /** @use HasFactory<MessageFactory> */
    use HasFactory, HasUlids;

    public const UPDATED_AT = null;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'type' => 'text',
    ];

    /**
     * `ulid` is a public id next to the integer primary key, not the primary key itself.
     *
     * @return list<string>
     */
    public function uniqueIds(): array
    {
        return ['ulid'];
    }

    public function getRouteKeyName(): string
    {
        return 'ulid';
    }

    /**
     * @return array<string, string>
     */
    protected function casts(): array
    {
        return [
            'conversation_id' => 'integer',
            'seq' => 'integer',
            'sender_type' => SenderType::class,
            'sender_user_id' => 'integer',
            'type' => MessageType::class,
            'delivered_at' => 'datetime',
            'seen_at' => 'datetime',
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
    public function senderUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'sender_user_id');
    }

    /**
     * @return HasMany<Attachment, $this>
     */
    public function attachments(): HasMany
    {
        return $this->hasMany(Attachment::class)->orderBy('id');
    }
}
