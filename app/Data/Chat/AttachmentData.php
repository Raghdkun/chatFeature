<?php

namespace App\Data\Chat;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Models\Attachment;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * An image attached to a message. `url` / `thumbUrl` are short-lived signed URLs from `AttachmentUrls`; the storage path,
 * disk, hash and original file name never leave the server through this class.
 */
#[TypeScript]
class AttachmentData extends Data
{
    public function __construct(
        public string $ulid,
        public string $mime,
        public int $size,
        public ?int $width,
        public ?int $height,
        public string $url,
        public ?string $thumbUrl,
    ) {}

    public static function fromModel(Attachment $attachment, ?AttachmentUrls $urls = null): self
    {
        $urls ??= app(AttachmentUrls::class);

        return new self(
            ulid: $attachment->ulid,
            mime: $attachment->mime,
            size: $attachment->size,
            width: $attachment->width,
            height: $attachment->height,
            url: $urls->url($attachment),
            thumbUrl: $urls->thumbUrl($attachment),
        );
    }
}
