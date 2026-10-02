<?php

namespace App\Data\WhatsApp;

use App\Models\Visitor;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The widget visitor a WhatsApp chat was linked to, as an administrator sees them: what they typed into the pre-chat form. No host-site
 * metadata, no external id, no session details.
 */
#[TypeScript]
class WaVisitorRefData extends Data
{
    public function __construct(
        public string $ulid,
        public ?string $name,
        public ?string $email,
        public ?string $phone,
        public bool $verified,
    ) {}

    public static function fromModel(Visitor $visitor): self
    {
        return new self(
            ulid: $visitor->ulid,
            name: $visitor->name,
            email: $visitor->email,
            phone: $visitor->phone,
            verified: $visitor->verified,
        );
    }
}
