<?php

namespace App\Data\Setup;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

#[TypeScript]
enum SetupStepStatus: string
{
    case Pending = 'pending';
    case Current = 'current';
    case Done = 'done';
}
