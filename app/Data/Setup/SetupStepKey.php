<?php

namespace App\Data\Setup;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The wizard screens, in order. `done` is rendered client-side after `write-lock` (the lock makes /setup 404). */
#[TypeScript]
enum SetupStepKey: string
{
    case Welcome = 'welcome';
    case Mode = 'mode';
    case Admin = 'admin';
    case Basics = 'basics';
    case Run = 'run';
    case Done = 'done';
}
