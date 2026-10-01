<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The authenticated staff member as shared with the dashboard (Inertia `auth.user`)
 * and returned by `GET /api/v1/auth/me`. Contract: docs/contracts/inertia-shared-props.md.
 */
#[TypeScript]
class AuthUserData extends Data
{
    public function __construct(
        public int $id,
        public string $name,
        public string $email,
        public ?string $avatar,
        public bool $is_admin,
        public bool $is_agent,
        public string $auth_source,
    ) {}
}
