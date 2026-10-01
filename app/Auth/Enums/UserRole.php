<?php

namespace App\Auth\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `users.role`: the local-mode source of truth that LocalRoleResolver derives is_admin / is_agent from. */
#[TypeScript]
enum UserRole: string
{
    case Admin = 'admin';
    case Agent = 'agent';
}
