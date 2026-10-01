<?php

namespace App\Data\Chat;

use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The agent as colleagues and admins see them (`{id, name}`): staff-facing payloads only, never sent to visitors. */
#[TypeScript]
class StaffAgentRefData extends Data
{
    public function __construct(
        public int $id,
        public string $name,
    ) {}

    public static function fromModel(User $agent): self
    {
        return new self(id: $agent->id, name: $agent->label);
    }
}
