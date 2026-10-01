<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Physical screen corner of the launcher. */
#[TypeScript]
enum PanelPosition: string
{
    case BottomRight = 'bottom-right';
    case BottomLeft = 'bottom-left';
}
