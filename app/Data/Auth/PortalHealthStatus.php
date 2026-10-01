<?php

namespace App\Data\Auth;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** What the app has observed about the auth portal lately. */
#[TypeScript]
enum PortalHealthStatus: string
{
    case Ok = 'ok';
    case Degraded = 'degraded';
    case Down = 'down';
    case Unknown = 'unknown';
}
