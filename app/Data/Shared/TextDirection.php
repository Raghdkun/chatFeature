<?php

namespace App\Data\Shared;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

#[TypeScript]
enum TextDirection: string
{
    case Ltr = 'ltr';
    case Rtl = 'rtl';
}
