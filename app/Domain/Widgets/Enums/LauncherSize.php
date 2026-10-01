<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Launcher diameter: sm 48 px, md 60 px, lg 72 px. */
#[TypeScript]
enum LauncherSize: string
{
    case Sm = 'sm';
    case Md = 'md';
    case Lg = 'lg';
}
