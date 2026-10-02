<?php

namespace App\Domain\Notifications\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Where a staff member is in the "enable notifications" dialog (decision P5-D7): never asked, said yes (browser permission
 * granted), said no or blocked it in the browser, or asked to be reminded later (`snoozed`, until `snoozed_until`).
 */
#[TypeScript]
enum PromptState: string
{
    case Never = 'never';
    case Granted = 'granted';
    case Denied = 'denied';
    case Snoozed = 'snoozed';
}
