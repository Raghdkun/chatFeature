<?php

namespace App\Data\Chat;

use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * The agent as a visitor sees them: display name and avatar only. Never an id, email or role.
 */
#[TypeScript]
class AgentRefData extends Data
{
    public function __construct(
        public string $name,
        public ?string $avatarUrl,
    ) {}

    public static function fromModel(User $agent): self
    {
        return new self(name: $agent->label, avatarUrl: $agent->avatar_url);
    }
}
