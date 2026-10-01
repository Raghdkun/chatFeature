<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Colour scheme of the widget panel. */
#[TypeScript]
enum ThemeMode: string
{
    case Auto = 'auto';
    case Light = 'light';
    case Dark = 'dark';
}
