<?php

namespace App\Data\Widgets;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Embed codes shown in the dashboard. */
#[TypeScript]
class WidgetSnippetsData extends Data
{
    public function __construct(
        public string $script,
        public string $iframe,
        public string $hosted,
        public IdentityExampleData $identity_example,
    ) {}
}
