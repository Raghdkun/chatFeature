<?php

namespace App\Data\Chat;

use App\Models\Visitor;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The little an agent learns about a visitor before accepting (`{name, verified}`): no contact details. */
#[TypeScript]
class OfferVisitorData extends Data
{
    public function __construct(
        public ?string $name,
        public bool $verified,
    ) {}

    public static function fromModel(Visitor $visitor): self
    {
        return new self(name: $visitor->name, verified: $visitor->verified);
    }
}
