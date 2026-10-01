<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Why a staff session was ended (`session.revoked` payload). */
#[TypeScript]
enum SessionRevokeReason: string
{
    case RoleRemoved = 'role_removed';
    case Deactivated = 'deactivated';
    case AuthRevoked = 'auth_revoked';
}
