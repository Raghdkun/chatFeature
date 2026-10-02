<?php

namespace App\Domain\Presence\Stores;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\PresenceRecord;
use App\Domain\Presence\PresenceTransition;
use App\Models\AgentPresence;
use App\Support\Database\DeadlockRetry;
use Carbon\CarbonInterface;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Presence kept in the `agent_presence` table itself (the P4 behaviour): every heartbeat is one UPDATE of the user's row, locked for the
 * read-modify-write so two concurrent calls never announce the same change twice. It never forgets a row (a zombie tab can revive a
 * stored `online`, as in P4). It is the store of small installs and of development, and what `FailoverPresenceStore` falls back to when
 * Redis is down.
 */
final class DatabasePresenceStore implements PresenceStore
{
    public function __construct(
        private readonly PresencePolicy $policy,
        private readonly PresenceMirror $mirror,
    ) {}

    public function find(int $userId, CarbonInterface $now): ?PresenceRecord
    {
        $row = AgentPresence::query()->where('user_id', $userId)->first();

        return $row === null ? null : PresenceRecord::fromModel($row);
    }

    public function findMany(array $userIds, CarbonInterface $now): array
    {
        if ($userIds === []) {
            return [];
        }

        $records = [];

        foreach (AgentPresence::query()->whereIn('user_id', $userIds)->get() as $row) {
            $records[$row->user_id] = PresenceRecord::fromModel($row);
        }

        return $records;
    }

    public function choose(int $userId, PresenceStatus $status, bool $manual, CarbonInterface $now): PresenceTransition
    {
        return $this->write($userId, $now, true, function (AgentPresence $row) use ($status, $manual, $now): void {
            $row->status = $status;
            $row->is_manual = $manual;
            $row->forceFill(['last_seen_at' => $now]);

            if ($status->isAvailable()) {
                $row->forceFill(['last_heartbeat_at' => $now, 'last_visible_at' => $now]);
            }
        });
    }

    public function beat(int $userId, bool $visible, CarbonInterface $now): PresenceTransition
    {
        return $this->write($userId, $now, false, function (AgentPresence $row) use ($visible, $now): void {
            if (! $row->status->isAvailable()) {
                // The agent chose Offline: the status rules do not change (a heartbeat never turns it on, the heartbeat time stays), but a
                // visible tab IS somebody looking at the dashboard, and `PresenceDashboardVisibility` reads that from here.
                $row->forceFill(['last_seen_at' => $now]);

                if ($visible) {
                    $row->forceFill(['last_visible_at' => $now]);
                }

                return;
            }

            $row->forceFill(['last_seen_at' => $now, 'last_heartbeat_at' => $now]);

            if ($visible) {
                $row->forceFill(['last_visible_at' => $now]);
            }
        });
    }

    public function reconcile(int $userId, CarbonInterface $now): PresenceTransition
    {
        return DeadlockRetry::transaction(function () use ($userId, $now): PresenceTransition {
            $row = AgentPresence::query()->where('user_id', $userId)->lockForUpdate()->first();

            if ($row === null) {
                return new PresenceTransition($userId, PresenceStatus::Offline, PresenceStatus::Offline);
            }

            $before = $row->effective_status ?? PresenceStatus::Offline;
            $record = PresenceRecord::fromModel($row);
            $after = $this->policy->effective($record, $now);

            if ($after !== $before) {
                $row->effective_status = $after;
                $row->save();
            }

            return new PresenceTransition($userId, $before, $after, $record->withAnnounced($after));
        });
    }

    public function forget(int $userId): void
    {
        AgentPresence::query()->where('user_id', $userId)->delete();
    }

    public function staleUserIds(CarbonInterface $now, int $limit): array
    {
        // The announced-reachable walk covers them: a row is stale only after it was announced as reachable.
        return [];
    }

    public function announcedReachableUserIds(int $afterUserId, int $limit): array
    {
        return $this->mirror->announcedReachableUserIds($afterUserId, $limit);
    }

    /**
     * A first write for a user locks the (missing) row's gap and then inserts into it, so two agents going online at the same moment
     * can pick each other as the deadlock victim (MySQL 1213): the transaction is run again, it never fails the request.
     *
     * @param  callable(AgentPresence): void  $change
     */
    private function write(int $userId, CarbonInterface $now, bool $create, callable $change): PresenceTransition
    {
        for ($attempt = 1; ; $attempt++) {
            try {
                return DeadlockRetry::transaction(function () use ($userId, $now, $create, $change): PresenceTransition {
                    $row = AgentPresence::query()->where('user_id', $userId)->lockForUpdate()->first();

                    if ($row === null && ! $create) {
                        return new PresenceTransition($userId, PresenceStatus::Offline, PresenceStatus::Offline);
                    }

                    // A row nobody has announced yet (written by P4, or by a test) counts as the status it implied.
                    $before = $row->effective_status ?? $this->policy->effective($row === null ? null : PresenceRecord::fromModel($row), $now);
                    $row ??= new AgentPresence(['user_id' => $userId]);

                    $change($row);

                    $after = $this->policy->effective(PresenceRecord::fromModel($row), $now);
                    $row->effective_status = $after;
                    $row->save();

                    return new PresenceTransition($userId, $before, $after, PresenceRecord::fromModel($row));
                });
            } catch (UniqueConstraintViolationException $exception) {
                // Two first-time writes raced for the one row per user: the second reads the winner's row and applies its change to it.
                if ($attempt >= 2) {
                    throw $exception;
                }
            }
        }
    }
}
