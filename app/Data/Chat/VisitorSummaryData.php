<?php

namespace App\Data\Chat;

use App\Data\Catalog\ObjectMapTransformer;
use App\Models\Visitor;
use Spatie\LaravelData\Attributes\WithTransformer;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What staff see about a visitor (contact details they gave, verification, host-site metadata). Staff-facing only:
 * `ConversationPublicData` never carries any of it. `meta` is always a JSON object.
 */
#[TypeScript]
class VisitorSummaryData extends Data
{
    /**
     * @param  array<string, scalar|null>  $meta
     */
    public function __construct(
        public string $ulid,
        public ?string $name,
        public ?string $email,
        public ?string $phone,
        public bool $verified,
        #[WithTransformer(ObjectMapTransformer::class)]
        public array $meta,
    ) {}

    public static function fromModel(Visitor $visitor): self
    {
        return new self(
            ulid: $visitor->ulid,
            name: $visitor->name,
            email: $visitor->email,
            phone: $visitor->phone,
            verified: $visitor->verified,
            meta: $visitor->meta ?? [],
        );
    }
}
