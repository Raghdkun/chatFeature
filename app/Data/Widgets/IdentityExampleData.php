<?php

namespace App\Data\Widgets;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Copy-paste server code that mints the signed visitor identity (HS256 JWT). */
#[TypeScript]
class IdentityExampleData extends Data
{
    public function __construct(
        public string $php,
        public string $node,
        public string $python,
    ) {}
}
