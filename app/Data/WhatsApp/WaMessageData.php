<?php

namespace App\Data\WhatsApp;

use App\Data\Chat\StaffAgentRefData;
use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\WaMessage;
use Illuminate\Support\Str;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * One message of the admin transcript. Admin-only. `chat` is the chat's ulid and `sentBy` the administrator who replied (outbound
 * rows); eager-load `chat` and `sentBy`. `error` is the failure text of a `failed` message (at most 500 characters). Not part of it: the WhatsApp message id,
 * the raw webhook object and the storage path of the file (`media` carries `{mime, filename, size, available, url}` only).
 */
#[TypeScript]
class WaMessageData extends Data
{
    public function __construct(
        public string $ulid,
        public string $chat,
        public WaDirection $direction,
        public WaMessageType $type,
        public ?string $body,
        public ?WaMediaData $media,
        public WaMessageStatus $status,
        public ?string $error,
        public ?StaffAgentRefData $sentBy,
        public string $waTimestamp,
        public string $createdAt,
    ) {}

    public static function fromModel(WaMessage $message, ?WaMediaUrls $urls = null): self
    {
        $hasMedia = $message->type->isMedia() || $message->media_mime !== null || $message->media_filename !== null || $message->hasStoredMedia();

        return new self(
            ulid: $message->ulid,
            chat: $message->chat->ulid,
            direction: $message->direction,
            type: $message->type,
            body: $message->body,
            media: $hasMedia ? WaMediaData::fromModel($message, $urls) : null,
            status: $message->status,
            error: $message->error === null ? null : Str::limit($message->error, 497),
            sentBy: $message->sentBy === null ? null : StaffAgentRefData::fromModel($message->sentBy),
            waTimestamp: (string) Timestamps::iso($message->wa_timestamp),
            createdAt: (string) Timestamps::iso($message->created_at),
        );
    }
}
