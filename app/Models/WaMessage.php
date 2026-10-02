<?php

namespace App\Models;

use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use Database\Factories\WaMessageFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Attributes\Hidden;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One recorded WhatsApp message. Inbound rows come from OpenWA webhooks, outbound rows are an administrator's replies (`sent_by_user_id`)
 * that exist from the moment they are accepted (`pending`) and move forward as acks arrive (`WaMessageStatus`). Plain text: every
 * client renders `body` as text. `raw` (the message object as OpenWA sent it) and `media_path` (a key on the private disk) never
 * leave the server; `WaMessageData` is the only shape a client gets.
 *
 * @property int $id
 * @property string $ulid
 * @property int $wa_chat_id
 * @property WaDirection $direction
 * @property string|null $wa_message_id
 * @property string|null $client_msg_id
 * @property WaMessageType $type
 * @property string|null $body
 * @property string|null $media_path
 * @property string|null $media_mime
 * @property string|null $media_filename
 * @property int|null $media_size
 * @property int|null $sent_by_user_id
 * @property WaMessageStatus $status
 * @property string|null $error
 * @property Carbon $wa_timestamp
 * @property array<string, mixed>|null $raw
 * @property Carbon|null $created_at
 * @property Carbon|null $updated_at
 * @property-read WaChat $chat
 * @property-read User|null $sentBy
 */
#[Fillable([
    'wa_chat_id', 'direction', 'wa_message_id', 'client_msg_id', 'type', 'body', 'media_path', 'media_mime', 'media_filename', 'media_size',
    'sent_by_user_id', 'status', 'error', 'wa_timestamp', 'raw',
])]
#[Hidden(['raw', 'media_path'])]
class WaMessage extends Model
{
    /** @use HasFactory<WaMessageFactory> */
    use HasFactory, HasUlids;

    /**
     * @var array<string, mixed>
     */
    protected $attributes = [
        'type' => 'text',
        'status' => 'received',
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
            'wa_chat_id' => 'integer',
            'direction' => WaDirection::class,
            'type' => WaMessageType::class,
            'media_size' => 'integer',
            'sent_by_user_id' => 'integer',
            'status' => WaMessageStatus::class,
            'wa_timestamp' => 'datetime',
            'raw' => 'array',
        ];
    }

    /**
     * @return BelongsTo<WaChat, $this>
     */
    public function chat(): BelongsTo
    {
        return $this->belongsTo(WaChat::class, 'wa_chat_id');
    }

    /**
     * The administrator who wrote an outbound message.
     *
     * @return BelongsTo<User, $this>
     */
    public function sentBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'sent_by_user_id');
    }

    public function isInbound(): bool
    {
        return $this->direction === WaDirection::In;
    }

    public function isOutbound(): bool
    {
        return $this->direction === WaDirection::Out;
    }

    /** The file of this message is stored on the private disk (images only in P6; other types are recorded as typed rows). */
    public function hasStoredMedia(): bool
    {
        return $this->media_path !== null && $this->media_path !== '';
    }
}
