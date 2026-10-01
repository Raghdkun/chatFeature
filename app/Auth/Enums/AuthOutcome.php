<?php

namespace App\Auth\Enums;

enum AuthOutcome: string
{
    case Ok = 'ok';
    case Invalid = 'invalid';
    case Unavailable = 'unavailable';
    case NoChatAccess = 'no_chat_access';
}
