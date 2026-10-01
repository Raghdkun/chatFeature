<?php

namespace App\Data\Shared;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\Optional as TypeScriptOptional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Inertia `flash` shared prop (session flash keys `success` / `error`). */
#[TypeScript]
class FlashData extends Data
{
    public function __construct(
        #[TypeScriptOptional]
        public string|Optional $success = new Optional,
        #[TypeScriptOptional]
        public string|Optional $error = new Optional,
    ) {}
}
