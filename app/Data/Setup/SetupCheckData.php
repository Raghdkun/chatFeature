<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\Optional as TypeScriptOptional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One row of the environment check (message is withheld until the setup token is verified). */
#[TypeScript]
class SetupCheckData extends Data
{
    public function __construct(
        public string $key,
        public string $label,
        public bool $ok,
        #[TypeScriptOptional]
        public string|Optional $message = new Optional,
    ) {}
}
