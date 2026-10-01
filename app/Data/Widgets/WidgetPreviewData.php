<?php

namespace App\Data\Widgets;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Where the builder's live preview loads the panel from. */
#[TypeScript]
class WidgetPreviewData extends Data
{
    public function __construct(
        public string $embed_url,
        public string $app_origin,
    ) {}
}
