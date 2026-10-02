<?php

namespace App\Data\WhatsApp;

use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Models\WaMessage;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The file of a WhatsApp message as a client sees it. `available` is true when the file is stored (images in P6) and `url` then is a
 * short-lived signed URL from `WaMediaUrls`; every other type is a typed row (`available: false`, no URL: "attachment not stored").
 * The storage path never leaves the server through this class.
 */
#[TypeScript]
class WaMediaData extends Data
{
    public function __construct(
        public ?string $mime,
        public ?string $filename,
        public ?int $size,
        public bool $available,
        public ?string $url,
    ) {}

    public static function fromModel(WaMessage $message, ?WaMediaUrls $urls = null): self
    {
        $available = $message->hasStoredMedia();

        return new self(
            mime: $message->media_mime,
            filename: $message->media_filename,
            size: $message->media_size,
            available: $available,
            url: $available ? ($urls ?? app(WaMediaUrls::class))->url($message) : null,
        );
    }
}
