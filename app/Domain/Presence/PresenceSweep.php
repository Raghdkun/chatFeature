<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;

/**
 * `chat:presence-sweep` (decision P5-D3): every minute, re-evaluate the agents whose status can change without any request: silent ones
 * (closed tab, sleeping laptop: no heartbeat for the window) go `offline`, automatic ones whose tabs are all hidden go `away`. A change
 * is announced once (`PresenceService::reconcile`: the event, the dropped availability cache, the mirror). Idempotent: a second run
 * finds nothing to change. Work is in batches of `presence.sweep_batch_size` users, and a store that cannot make progress on a batch (a
 * member that stays stale after being checked) cannot make the sweep loop forever.
 */
final class PresenceSweep
{
    /** An upper bound on the rounds over silent users, far above any real number of agents. */
    private const MAX_STALE_ROUNDS = 200;

    public function __construct(
        private readonly PresenceStore $store,
        private readonly PresenceService $presence,
    ) {}

    /**
     * @return array{checked: int, changed: int, offline: int, away: int, online: int}
     */
    public function run(): array
    {
        $batch = max(1, (int) config('presence.sweep_batch_size', 200));
        $result = ['checked' => 0, 'changed' => 0, 'offline' => 0, 'away' => 0, 'online' => 0];
        $seen = [];

        // 1. Users whose last heartbeat is older than the window (Redis: a range query on the heartbeat set).
        for ($round = 0; $round < self::MAX_STALE_ROUNDS; $round++) {
            $ids = array_values(array_diff($this->store->staleUserIds(now(), $batch), $seen));

            if ($ids === []) {
                break;
            }

            $this->check($ids, $seen, $result);
        }

        // 2. Everybody last announced as reachable (silence the set above does not know of, auto-away), in id order.
        $after = 0;

        do {
            $ids = $this->store->announcedReachableUserIds($after, $batch);

            if ($ids === []) {
                break;
            }

            $after = max($ids);
            $this->check(array_values(array_diff($ids, $seen)), $seen, $result);
        } while (count($ids) >= $batch);

        return $result;
    }

    /**
     * @param  list<int>  $ids
     * @param  array<int, int>  $seen
     * @param  array{checked: int, changed: int, offline: int, away: int, online: int}  $result
     */
    private function check(array $ids, array &$seen, array &$result): void
    {
        foreach ($ids as $id) {
            $seen[$id] = $id;
            $transition = $this->presence->reconcile($id);
            $result['checked']++;

            if ($transition->changed()) {
                $result['changed']++;
                $result[match ($transition->after) {
                    PresenceStatus::Offline => 'offline',
                    PresenceStatus::Away => 'away',
                    PresenceStatus::Online => 'online',
                }]++;
            }
        }
    }
}
