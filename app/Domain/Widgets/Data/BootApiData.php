<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Where the loader talks to: public API base, the iframe page and the postMessage origin to trust. */
#[TypeScript]
class BootApiData extends Data
{
    public function __construct(
        public string $base,
        public string $embed,
        public string $appOrigin,
    ) {}
}
