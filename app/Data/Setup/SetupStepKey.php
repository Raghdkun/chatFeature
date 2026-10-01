<?php

namespace App\Data\Setup;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The wizard screens, in order. `admin` is for mode `fortify` only; `pizzasys` and `portal-admin` for mode `pizzasys` only.
 * `done` is rendered client-side after `write-lock` (the lock makes /setup 404).
 */
#[TypeScript]
enum SetupStepKey: string
{
    case Welcome = 'welcome';
    case Mode = 'mode';
    case Admin = 'admin';
    case Pizzasys = 'pizzasys';
    case PortalAdmin = 'portal-admin';
    case Basics = 'basics';
    case Run = 'run';
    case Done = 'done';
}
