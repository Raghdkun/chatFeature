<?php

namespace App\Data\Setup;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The already-entered first admin. The password (or its hash) is never sent back. */
#[TypeScript]
class SetupAdminData extends Data
{
    public function __construct(
        public string $name,
        public string $email,
    ) {}
}
