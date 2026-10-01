<?php

namespace App\Data\Agents;

use App\Domain\Widgets\Support\Timestamps;
use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A staff member in the agents list. `id` is the user id (staff-only API); never carries tokens, permissions or external ids.
 */
#[TypeScript]
class AgentListItemData extends Data
{
    /**
     * @param  array<int, string>  $category_ulids
     */
    public function __construct(
        public int $id,
        public string $name,
        public string $email,
        public ?string $avatar,
        public bool $is_admin,
        public bool $is_agent,
        public bool $is_active,
        public string $auth_source,
        public array $category_ulids,
        public int $max_concurrent_chats,
        public ?string $last_seen_at,
    ) {}

    /**
     * @param  array<int, string>  $categoryUlids
     */
    public static function fromUser(User $user, array $categoryUlids): self
    {
        return new self(
            id: $user->id,
            name: $user->name,
            email: $user->email,
            avatar: $user->avatar_url,
            is_admin: $user->is_admin,
            is_agent: $user->is_agent,
            is_active: $user->is_active,
            auth_source: $user->auth_source,
            category_ulids: array_values($categoryUlids),
            max_concurrent_chats: $user->max_concurrent_chats,
            last_seen_at: Timestamps::iso($user->last_seen_at),
        );
    }
}
