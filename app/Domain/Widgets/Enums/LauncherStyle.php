<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Launcher presentation. */
#[TypeScript]
enum LauncherStyle: string
{
    case Bubble = 'bubble';
    case Pill = 'pill';
}
