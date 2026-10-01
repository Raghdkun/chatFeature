<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A category a visitor may pick (already filtered to the widget's enabled, active categories). */
#[TypeScript]
class BootCategoryData extends Data
{
    public function __construct(
        public string $slug,
        public string $label,
        public ?string $description = null,
        public ?string $icon = null,
        public ?string $color = null,
    ) {}
}
