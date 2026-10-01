<?php

namespace App\Data\Setup;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

#[TypeScript]
enum SetupRunStatus: string
{
    case Pending = 'pending';
    case Running = 'running';
    case Done = 'done';
    case Failed = 'failed';
}
