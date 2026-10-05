<?php

namespace App\Data\Dashboard;

use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Whether the signed-in member of staff can be offered chats: an agent who serves no category is online and still never gets one.
 */
#[TypeScript]
class ServingStatusData extends Data
{
    public function __construct(
        /** The account takes chats (agent role, active). */
        public bool $takesChats,
        /** Active categories the account serves. */
        public int $categories,
    ) {}

    public static function for(User $user): self
    {
        $takesChats = $user->is_agent && $user->is_active;

        return new self($takesChats, $takesChats ? $user->categories()->where('categories.is_active', true)->count() : 0);
    }
}
