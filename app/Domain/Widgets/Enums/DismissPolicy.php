<?php

namespace App\Domain\Widgets\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** How long a dismissed greeting stays away. */
#[TypeScript]
enum DismissPolicy: string
{
    case Session = 'session';
    case Interval = 'interval';
    case Never = 'never';
}
