<?php

namespace App\Data\Auth;

use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The authenticated staff member as shared with the dashboard (Inertia `auth.user`)
 * and returned by `GET /api/v1/auth/me`. Contract: docs/contracts/inertia-shared-props.md.
 *
 * Never carries permission lists, external tokens, upstream role names or `external_id`.
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

    public static function fromUser(User $user): self
    {
        return new self(
            id: $user->id,
            name: $user->name,
            email: $user->email,
            avatar: $user->avatar_url,
            is_admin: $user->is_admin,
            is_agent: $user->is_agent,
            auth_source: $user->auth_source,
        );
    }
}
