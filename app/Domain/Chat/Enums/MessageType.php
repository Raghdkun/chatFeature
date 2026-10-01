<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** What a message is: plain text, an image (attachments), or a server-written line ("agent joined"). */
#[TypeScript]
enum MessageType: string
{
    case Text = 'text';
    case Image = 'image';
    case System = 'system';
}
