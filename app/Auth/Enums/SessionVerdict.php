<?php

namespace App\Auth\Enums;

enum SessionVerdict: string
{
    case Fresh = 'fresh';
    case Revalidated = 'revalidated';
    case Revoked = 'revoked';
    case Degraded = 'degraded';
}
