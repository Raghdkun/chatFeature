<?php

namespace App\Data\Chat;

use App\Models\Category;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A category as chat payloads name it: its slug and the label to show (`{slug, label}`, docs/contracts/realtime-events.md). */
#[TypeScript]
class CategoryRefData extends Data
{
    public function __construct(
        public string $slug,
        public string $label,
    ) {}

    public static function fromModel(Category $category): self
    {
        return new self(slug: $category->slug, label: $category->name);
    }
}
