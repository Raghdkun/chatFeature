<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Agent presence status a routing wave targets. */
#[TypeScript]
enum RoutingStatus: string
{
    case Online = 'online';
    case Away = 'away';
    case Offline = 'offline';
}
