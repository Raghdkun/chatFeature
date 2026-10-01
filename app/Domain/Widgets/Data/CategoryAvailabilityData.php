<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Per-category availability inside AvailabilityData. */
#[TypeScript]
class CategoryAvailabilityData extends Data
{
    public function __construct(
        public string $slug,
        public bool $online,
    ) {}
}
