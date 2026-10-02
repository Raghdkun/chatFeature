<?php

namespace App\Domain\Presence\Contracts;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Exceptions\PresenceStoreUnavailable;
use App\Domain\Presence\PresenceRecord;
use App\Domain\Presence\PresenceTransition;
use Carbon\CarbonInterface;

/**
 * Where agents' live presence is kept (decision P5-D1): Redis, or the `agent_presence` table. A store holds the raw facts
 * (`PresenceRecord`); what they mean is `PresencePolicy`, and what a change triggers (the `PresenceChanged` event, the cached public
 * availability) is `PresenceService`: a store only reports, in a `PresenceTransition`, whether THIS call moved the announced status.
 *
 * Every method takes the instant it applies to (tests move it). Writes are atomic per user: two concurrent calls never both report the
 * same change.
 *
 * @throws PresenceStoreUnavailable (any method) when the backing service cannot be reached; `FailoverPresenceStore` turns that into
 *                                  the database store
 */
interface PresenceStore
{
    /** The record of one user, or null when the store has none (never seen, or forgotten). */
    public function find(int $userId, CarbonInterface $now): ?PresenceRecord;

    /**
     * One read for many users.
     *
     * @param  list<int>  $userIds
     * @return array<int, PresenceRecord> by user id; users without a record are missing
     */
    public function findMany(array $userIds, CarbonInterface $now): array;

    /**
     * The agent picks a status (`PUT /me/presence`). `online` and `away` also count as a (visible) heartbeat; `offline` leaves the last
     * heartbeat alone. `$manual` = pinned: auto-away never moves it (an automatic `online` follows the dashboard instead).
     */
    public function choose(int $userId, PresenceStatus $status, bool $manual, CarbonInterface $now): PresenceTransition;

    /**
     * A dashboard heartbeat. Refreshes a stored `online` / `away`; it never turns an `offline` or unknown agent on. `$visible` = the
     * tab that sent it is in the foreground (a visible beat is what keeps an automatic agent `online`).
     */
    public function beat(int $userId, bool $visible, CarbonInterface $now): PresenceTransition;

    /** The sweep's step: re-evaluate the user at `$now` (silence, auto-away) and announce what changed since the last announcement. */
    public function reconcile(int $userId, CarbonInterface $now): PresenceTransition;

    /** Drop everything the store holds about the user (they cannot take chats any more, or a test cleans up). */
    public function forget(int $userId): void;

    /**
     * Users whose last heartbeat is older than the window and who the store has not looked at since: the sweep re-checks them first.
     *
     * @return list<int>
     */
    public function staleUserIds(CarbonInterface $now, int $limit): array;

    /**
     * Users last announced as `online` or `away` (the sweep re-checks them: silence, auto-away), by ascending id.
     *
     * @return list<int>
     */
    public function announcedReachableUserIds(int $afterUserId, int $limit): array;
}
