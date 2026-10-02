<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What a recorded WhatsApp message is. OpenWA reports `text | image | video | audio | voice | document | sticker | location | contact |
 * poll | call | revoked | order | product | masked | unknown` (and the raw engine names `chat`, `ptt`, `vcard` can leak through); anything the
 * application does not render maps to `other`, so a new OpenWA type never fails a delivery.
 */
#[TypeScript]
enum WaMessageType: string
{
    case Text = 'text';
    case Image = 'image';
    case Video = 'video';
    case Audio = 'audio';
    case Voice = 'voice';
    case Document = 'document';
    case Sticker = 'sticker';
    case Location = 'location';
    case Contact = 'contact';
    case Other = 'other';

    /** Tolerant mapping of OpenWA's `type` string (case-insensitive, unknown and empty values become `other`). */
    public static function fromOpenWa(?string $type): self
    {
        return match (strtolower(trim((string) $type))) {
            'text', 'chat' => self::Text,
            'image' => self::Image,
            'video', 'gif' => self::Video,
            'audio' => self::Audio,
            'voice', 'ptt' => self::Voice,
            'document' => self::Document,
            'sticker' => self::Sticker,
            'location', 'live_location' => self::Location,
            'contact', 'vcard', 'multi_vcard' => self::Contact,
            default => self::Other,
        };
    }

    /** Carries a file (a media blob, or the marker OpenWA sends instead of a large one). */
    public function isMedia(): bool
    {
        return in_array($this, [self::Image, self::Video, self::Audio, self::Voice, self::Document, self::Sticker], true);
    }

    /** P6 stores the file of an image only (re-encoded by the image sanitizer); every other type is recorded as a typed row (decision P6-D7). */
    public function isStoredAsFile(): bool
    {
        return $this === self::Image;
    }
}
