<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use Carbon\CarbonInterface;

/**
 * The one definition of an agent's EFFECTIVE status (decision P5-D2), shared by every store so routing, the public availability,
 * `GET /me/presence` and the roster can never disagree:
 *
 * - no record, a stored `offline` (the agent's own choice: a heartbeat never turns it on) or no heartbeat for `windowSeconds` = `offline`;
 * - a status the agent pinned by hand (`manual`) wins: `online` stays `online`, `away` stays `away`, while heartbeats keep coming;
 * - otherwise (automatic `online`): `online` while a tab is visible, `away` once every heartbeat has reported a hidden tab for
 *   `autoAwayMinutes` (a visible heartbeat makes it `online` again). 0 minutes turns auto-away off.
 *
 * A heartbeat exactly `windowSeconds` old still counts; one second more does not.
 */
final class PresencePolicy
{
    public function __construct(
        private readonly int $windowSeconds = 90,
        private readonly int $autoAwayMinutes = 5,
    ) {}

    public static function fromConfig(): self
    {
        return new self(max(1, (int) config('presence.heartbeat_window_seconds', 90)), max(0, (int) config('presence.auto_away_minutes', 5)));
    }

    public function windowSeconds(): int
    {
        return $this->windowSeconds;
    }

    public function autoAwayMinutes(): int
    {
        return $this->autoAwayMinutes;
    }

    /** How long a record is kept after its last sign of life: a little silence longer than the window still lets a heartbeat revive it. */
    public function lifetimeSeconds(): int
    {
        return 2 * $this->windowSeconds;
    }

    public function isFresh(?CarbonInterface $heartbeatAt, CarbonInterface $now): bool
    {
        return $heartbeatAt !== null && $heartbeatAt->getTimestamp() >= $now->getTimestamp() - $this->windowSeconds;
    }

    public function effective(?PresenceRecord $record, CarbonInterface $now): PresenceStatus
    {
        if ($record === null || $record->status === PresenceStatus::Offline || ! $this->isFresh($record->heartbeatAt, $now)) {
            return PresenceStatus::Offline;
        }

        if ($record->manual || $record->status === PresenceStatus::Away) {
            return $record->status;
        }

        return $this->hiddenLongEnough($record, $now) ? PresenceStatus::Away : PresenceStatus::Online;
    }

    private function hiddenLongEnough(PresenceRecord $record, CarbonInterface $now): bool
    {
        // A record without a visible beat on file (written before auto-away existed) counts as visible at its last heartbeat.
        $visibleAt = $record->visibleAt ?? $record->heartbeatAt;

        return $this->autoAwayMinutes > 0
            && $visibleAt !== null
            && $now->getTimestamp() - $visibleAt->getTimestamp() >= $this->autoAwayMinutes * 60;
    }
}
