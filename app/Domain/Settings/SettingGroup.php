<?php

namespace App\Domain\Settings;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Settings are namespaced by group; the key prefix (`app.name`) matches the group value. */
#[TypeScript]
enum SettingGroup: string
{
    case App = 'app';
    case Auth = 'auth';
    case Chat = 'chat';
    case Notifications = 'notifications';
    case Storage = 'storage';
    case WhatsApp = 'whatsapp';
}
