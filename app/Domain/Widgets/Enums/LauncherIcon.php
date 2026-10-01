<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Launcher glyph. */
#[TypeScript]
enum LauncherIcon: string
{
    case Chat = 'chat';
    case Help = 'help';
    case Sparkle = 'sparkle';
    case Custom = 'custom';
}
