<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\LaravelData\Optional;
use Spatie\TypeScriptTransformer\Attributes\Optional as TypeScriptOptional;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One row of a portal connection test (docs/contracts/auth-pizzasys.md `PortalCheck`). */
#[TypeScript]
class PortalCheckData extends Data
{
    public function __construct(
        public PortalCheckKey $key,
        public string $label,
        public bool $ok,
        #[TypeScriptOptional]
        public string|Optional $message = new Optional,
    ) {}
}
