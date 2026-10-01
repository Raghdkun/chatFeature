<?php

namespace App\Data\Chat;

use App\Models\Widget;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A widget as staff-facing chat payloads name it (`{ulid, name}`). */
#[TypeScript]
class WidgetRefData extends Data
{
    public function __construct(
        public string $ulid,
        public string $name,
    ) {}

    public static function fromModel(Widget $widget): self
    {
        return new self(ulid: $widget->ulid, name: $widget->name);
    }
}
