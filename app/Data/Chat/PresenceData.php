<?php

namespace App\Data\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\AgentPresence;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A staff member's presence (`GET /me/presence`): the status, whether they chose it themselves, and when they were last seen. */
#[TypeScript]
class PresenceData extends Data
{
    public function __construct(
        public int $userId,
        public PresenceStatus $status,
        public bool $isManual,
        public ?string $lastSeenAt,
    ) {}

    public static function fromModel(AgentPresence $presence): self
    {
        return new self(
            userId: $presence->user_id,
            status: $presence->status,
            isManual: $presence->is_manual,
            lastSeenAt: Timestamps::iso($presence->last_seen_at),
        );
    }
}
