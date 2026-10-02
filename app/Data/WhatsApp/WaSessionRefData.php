<?php

namespace App\Data\WhatsApp;

use App\Models\WhatsAppSession;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A WhatsApp session as chat payloads name it (`{ulid, name}`). Admin-only. */
#[TypeScript]
class WaSessionRefData extends Data
{
    public function __construct(
        public string $ulid,
        public string $name,
    ) {}

    public static function fromModel(WhatsAppSession $session): self
    {
        return new self(ulid: $session->ulid, name: $session->name);
    }
}
