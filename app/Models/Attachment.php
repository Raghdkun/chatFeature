<?php

namespace App\Models;

use App\Domain\Chat\Enums\SenderType;
use Database\Factories\AttachmentFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * An uploaded image of a conversation (re-encoded by the pipeline, EXIF stripped). Uploaded first, then referenced by the
 * next message (`message_id` stays null until then). `original_name` is the sanitised file name, shown to staff only.
 * Files are served through short-lived signed URLs (`App\Domain\Chat\Contracts\AttachmentUrls`), never a public disk path.
 *
 * @property int $id
 * @property string $ulid
 * @property int $conversation_id
 * @property int|null $message_id
 * @property SenderType $uploader_type
 * @property int|null $uploader_user_id
 * @property string $disk
 * @property string $path
 * @property string|null $thumb_path
 * @property string $mime
 * @property int $size
 * @property int|null $width
 * @property int|null $height
 * @property string $sha256
 * @property string|null $original_name
 * @property int $position
 * @property Carbon|null $created_at
 * @property-read Conversation $conversation
 * @property-read Message|null $message
 */
#[Fillable(['conversation_id', 'message_id', 'uploader_type', 'uploader_user_id', 'disk', 'path', 'thumb_path', 'mime', 'size', 'width', 'height', 'sha256', 'original_name', 'position'])]
class Attachment extends Model
{
    /** @use HasFactory<AttachmentFactory> */
    use HasFactory, HasUlids;

    public const UPDATED_AT = null;

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
            'message_id' => 'integer',
            'uploader_type' => SenderType::class,
            'uploader_user_id' => 'integer',
            'size' => 'integer',
            'width' => 'integer',
            'height' => 'integer',
            'position' => 'integer',
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
     * @return BelongsTo<Message, $this>
     */
    public function message(): BelongsTo
    {
        return $this->belongsTo(Message::class);
    }

    /**
     * @return BelongsTo<User, $this>
     */
    public function uploaderUser(): BelongsTo
    {
        return $this->belongsTo(User::class, 'uploader_user_id');
    }
}
