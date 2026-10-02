<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\AgentPresence;
use Carbon\CarbonInterface;

/**
 * The `agent_presence` row as a MIRROR of what Redis holds (the database store does not use this to keep state: its row is the
 * state). It is written only when the effective status changes, so a heartbeat costs no SQL; the sweep walks the rows announced as
 * reachable, and the database store takes over from it when Redis is down.
 */
final class PresenceMirror
{
    public function announced(int $userId): ?PresenceStatus
    {
        return AgentPresence::query()->where('user_id', $userId)->first(['effective_status'])?->effective_status;
    }

    public function write(PresenceRecord $record, PresenceStatus $effective, CarbonInterface $now): void
    {
        AgentPresence::query()->upsert([[
            'user_id' => $record->userId,
            'status' => $record->status->value,
            'is_manual' => $record->manual,
            'last_seen_at' => ($record->seenAt ?? $now)->toDateTimeString(),
            'last_heartbeat_at' => $record->heartbeatAt?->toDateTimeString(),
            'last_visible_at' => $record->visibleAt?->toDateTimeString(),
            'effective_status' => $effective->value,
        ]], ['user_id'], ['status', 'is_manual', 'last_seen_at', 'last_heartbeat_at', 'last_visible_at', 'effective_status']);
    }

    /** Marks the user offline in the mirror if it still says `$expected` (nothing else remembers them: the sweep found no Redis record). */
    public function markOffline(int $userId, PresenceStatus $expected): bool
    {
        return AgentPresence::query()
            ->where('user_id', $userId)
            ->where('effective_status', $expected->value)
            ->update(['effective_status' => PresenceStatus::Offline->value]) > 0;
    }

    /**
     * @return list<int>
     */
    public function announcedReachableUserIds(int $afterUserId, int $limit): array
    {
        return array_values(array_map(intval(...), AgentPresence::query()
            ->whereIn('effective_status', [PresenceStatus::Online->value, PresenceStatus::Away->value])
            ->where('user_id', '>', $afterUserId)
            ->orderBy('user_id')
            ->limit($limit)
            ->pluck('user_id')
            ->all()));
    }
}
