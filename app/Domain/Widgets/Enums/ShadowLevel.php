<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Elevation of the launcher and the panel. */
#[TypeScript]
enum ShadowLevel: string
{
    case None = 'none';
    case Soft = 'soft';
    case Strong = 'strong';
}
