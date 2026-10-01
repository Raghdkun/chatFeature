<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\User;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A colleague a chat can be handed to (`GET /conversations/{ulid}/transfer-targets`): name, avatar, effective presence and load,
 * and whether the server would accept the transfer right now (`reachable`: the very check `POST .../transfer` makes). Staff only;
 * no e-mail address.
 */
#[TypeScript]
class TransferAgentData extends Data
{
    public function __construct(
        public int $id,
        public string $name,
        public ?string $avatarUrl,
        public PresenceStatus $status,
        public int $activeChats,
        public int $maxConcurrentChats,
        public bool $reachable,
    ) {}

    public static function fromModel(User $agent, PresenceStatus $status, int $activeChats, bool $reachable): self
    {
        return new self(
            id: $agent->id,
            name: $agent->label,
            avatarUrl: $agent->avatar_url,
            status: $status,
            activeChats: $activeChats,
            maxConcurrentChats: max(1, (int) $agent->max_concurrent_chats),
            reachable: $reachable,
        );
    }
}
