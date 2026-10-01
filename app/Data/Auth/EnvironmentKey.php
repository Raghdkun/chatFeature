<?php

namespace App\Data\Auth;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The two auth-portal environments (settings `auth.pizzasys.active_env`). */
#[TypeScript]
enum EnvironmentKey: string
{
    case Production = 'production';
    case Testing = 'testing';
}
