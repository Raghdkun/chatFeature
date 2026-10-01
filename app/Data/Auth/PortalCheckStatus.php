<?php

namespace App\Data\Auth;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Result of the last connection test of an environment. */
#[TypeScript]
enum PortalCheckStatus: string
{
    case Ok = 'ok';
    case Failed = 'failed';
}
