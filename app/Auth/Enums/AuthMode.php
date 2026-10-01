<?php

namespace App\Auth\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Value of the `auth.mode` setting. Locked once the setup wizard has finished. */
#[TypeScript]
enum AuthMode: string
{
    case Fortify = 'fortify';
    case Pizzasys = 'pizzasys';
}
