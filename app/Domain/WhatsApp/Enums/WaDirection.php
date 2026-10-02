<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Which way a recorded WhatsApp message went: `in` (the customer wrote it) or `out` (an administrator replied through OpenWA). */
#[TypeScript]
enum WaDirection: string
{
    case In = 'in';
    case Out = 'out';

    public function isInbound(): bool
    {
        return $this === self::In;
    }
}
