<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Whether a widget can take chats right now (docs/contracts/rest-shapes.md).
 * `online` = open per the hours AND at least one enabled category has an available agent.
 */
#[TypeScript]
class AvailabilityData extends Data
{
    /**
     * @param  array<int, CategoryAvailabilityData>  $categories
     */
    public function __construct(
        public bool $online,
        public bool $openNow,
        public ?string $nextOpenAt,
        public array $categories,
        public WhatsappAvailabilityData $whatsapp,
    ) {}
}
