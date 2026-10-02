<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\AgentPresence;
use Carbon\CarbonImmutable;

/**
 * What a presence store knows about one staff member: the status they chose, whether they pinned it, and the last time a heartbeat
 * (and a heartbeat from a VISIBLE tab) arrived. `announced` is the effective status clients were last told, so a change is announced
 * once. The effective status itself is `PresencePolicy::effective()`: it depends on the time it is asked at.
 */
final readonly class PresenceRecord
{
    public function __construct(
        public int $userId,
        public PresenceStatus $status,
        public bool $manual,
        public ?CarbonImmutable $heartbeatAt = null,
        public ?CarbonImmutable $visibleAt = null,
        public ?CarbonImmutable $seenAt = null,
        public ?PresenceStatus $announced = null,
    ) {}

    public static function fromModel(AgentPresence $presence): self
    {
        return new self(
            userId: $presence->user_id,
            status: $presence->status,
            manual: $presence->is_manual,
            heartbeatAt: $presence->last_heartbeat_at?->toImmutable(),
            visibleAt: $presence->last_visible_at?->toImmutable(),
            seenAt: $presence->last_seen_at?->toImmutable(),
            announced: $presence->effective_status,
        );
    }

    /** An unsaved model with the record's values (what `PresenceService::current()` hands to its callers). */
    public function toModel(): AgentPresence
    {
        return new AgentPresence([
            'user_id' => $this->userId,
            'status' => $this->status,
            'is_manual' => $this->manual,
            'last_seen_at' => $this->seenAt,
            'last_heartbeat_at' => $this->heartbeatAt,
            'last_visible_at' => $this->visibleAt,
            'effective_status' => $this->announced,
        ]);
    }

    /** The last sign of life of any kind: a heartbeat or a status choice. */
    public function activityAt(): ?CarbonImmutable
    {
        if ($this->heartbeatAt === null || $this->seenAt === null) {
            return $this->heartbeatAt ?? $this->seenAt;
        }

        return $this->heartbeatAt->gt($this->seenAt) ? $this->heartbeatAt : $this->seenAt;
    }

    public function withAnnounced(PresenceStatus $status): self
    {
        return new self($this->userId, $this->status, $this->manual, $this->heartbeatAt, $this->visibleAt, $this->seenAt, $status);
    }
}
