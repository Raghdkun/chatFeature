<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Member info of the `presence-staff` channel (`{id, name, avatarUrl, status}`): staff only, no email. */
#[TypeScript]
class PresenceMemberData extends Data
{
    public function __construct(
        public int $id,
        public string $name,
        public ?string $avatarUrl,
        public PresenceStatus $status,
    ) {}

    public static function fromModel(User $user, PresenceStatus $status): self
    {
        return new self(id: $user->id, name: $user->label, avatarUrl: $user->avatar_url, status: $status);
    }
}
