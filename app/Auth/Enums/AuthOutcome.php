<?php

namespace App\Auth\Enums;

enum AuthOutcome: string
{
    case Ok = 'ok';
    case Invalid = 'invalid';
    case Unavailable = 'unavailable';
    case NoChatAccess = 'no_chat_access';

    /** API sign-in only (local accounts): the password is right but the account has a second factor, so no token may be issued yet. */
    case TwoFactorRequired = 'two_factor_required';
}
