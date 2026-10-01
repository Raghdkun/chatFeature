<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The portal administrator verified during the wizard (no token, no portal id). */
#[TypeScript]
class PizzasysPortalAdminData extends Data
{
    public function __construct(
        public string $name,
        public string $email,
    ) {}
}
