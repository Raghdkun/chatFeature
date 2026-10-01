<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** How a widget decides whether it is open (`widgets.offline_mode`, mirrored as `hours.mode` in the config). */
#[TypeScript]
enum OfflineMode: string
{
    case AutoHours = 'auto_hours';
    case AlwaysOnline = 'always_online';
    case AlwaysOffline = 'always_offline';
}
