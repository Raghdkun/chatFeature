<?php

namespace App\Data\WhatsApp;

use App\Domain\Widgets\Support\Timestamps;
use Carbon\CarbonInterface;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The pairing QR of a session, only ever returned by `GET /whatsapp/sessions/{ulid}/qr` (`Cache-Control: no-store`): a PNG data URL for an
 * `<img>` and when OpenWA made it. A QR is a login credential while it is valid: it is in no other payload and never broadcast.
 */
#[TypeScript]
class WhatsAppQrData extends Data
{
    public function __construct(
        public string $qr,
        public string $updatedAt,
    ) {}

    public static function make(string $dataUrl, CarbonInterface $updatedAt): self
    {
        return new self(qr: $dataUrl, updatedAt: (string) Timestamps::iso($updatedAt));
    }
}
