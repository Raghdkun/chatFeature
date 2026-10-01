<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One pre-chat form field. A required field is always enabled. */
#[TypeScript]
class PreChatFieldData extends Data
{
    public function __construct(
        public bool $enabled = false,
        public bool $required = false,
    ) {}
}
