<?php

namespace App\Auth\Enums;

enum SessionVerdict: string
{
    case Fresh = 'fresh';
    case Revalidated = 'revalidated';
    case Revoked = 'revoked';
    case Degraded = 'degraded';

    /**
     * Additive (P2): the auth portal cannot be reached and the grace window is over. The session is kept, but the
     * request is answered 503 (`auth_unavailable`) instead of logging the user out.
     */
    case Unavailable = 'unavailable';
}
