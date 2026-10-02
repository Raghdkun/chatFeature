<?php

namespace App\Domain\Presence\Stores;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Exceptions\PresenceStoreUnavailable;
use App\Domain\Presence\PresenceRecord;
use App\Domain\Presence\PresenceTransition;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Cache\Repository as Cache;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The failure mode of the Redis store: when Redis cannot be reached (`PresenceStoreUnavailable`) the call is answered by the database
 * store instead, never by a 500, and Redis is not tried again for `cooldownSeconds` (so a dead or blackholed host costs one slow call
 * per cooldown, not one per heartbeat). One warning is logged per switch.
 *
 * The cooldown has to outlive a request: under PHP-FPM (and `php artisan serve`) every request boots a fresh application, so a value kept
 * in this object alone is forgotten at once and EVERY call would try Redis again and log again (found by the e2e suite). It is therefore
 * also kept in `$shared`, a cache store that does not depend on Redis (`presence.failure_store`, the file store by default: the
 * processes of one server share its disk): the instant the cooldown ends, for as long as it lasts. A process that finds it goes straight
 * to the database store, silently; a cache that cannot be reached only means the cooldown is per object again.
 *
 * What the switch means for agents: the `agent_presence` rows (the mirror Redis kept, plus every heartbeat the database store writes
 * from now on) become the truth. Each agent's next heartbeat (within 30 s) restores them from the mirror; whoever was `online`/`away`
 * at the last mirrored change stays that. After Redis returns, its records are cold or old: agents whose last record there was too long ago
 * read `offline` until they choose a status again, and the next sweep announces it. Nothing is lost permanently and nothing is left
 * inconsistent between routing, availability and the roster, because all of them read through this one store.
 */
final class FailoverPresenceStore implements PresenceStore
{
    private const COOLDOWN_KEY = 'presence:redis-down-until';

    private ?int $redisDownUntil = null;

    public function __construct(
        private readonly PresenceStore $primary,
        private readonly PresenceStore $fallback,
        private readonly int $cooldownSeconds = 15,
        private readonly ?Cache $shared = null,
    ) {}

    public function find(int $userId, CarbonInterface $now): ?PresenceRecord
    {
        return $this->run(fn (PresenceStore $store): ?PresenceRecord => $store->find($userId, $now));
    }

    public function findMany(array $userIds, CarbonInterface $now): array
    {
        return $this->run(fn (PresenceStore $store): array => $store->findMany($userIds, $now));
    }

    public function choose(int $userId, PresenceStatus $status, bool $manual, CarbonInterface $now): PresenceTransition
    {
        return $this->run(fn (PresenceStore $store): PresenceTransition => $store->choose($userId, $status, $manual, $now));
    }

    public function beat(int $userId, bool $visible, CarbonInterface $now): PresenceTransition
    {
        return $this->run(fn (PresenceStore $store): PresenceTransition => $store->beat($userId, $visible, $now));
    }

    public function reconcile(int $userId, CarbonInterface $now): PresenceTransition
    {
        return $this->run(fn (PresenceStore $store): PresenceTransition => $store->reconcile($userId, $now));
    }

    public function forget(int $userId): void
    {
        $this->run(fn (PresenceStore $store) => $store->forget($userId));
    }

    public function staleUserIds(CarbonInterface $now, int $limit): array
    {
        return $this->run(fn (PresenceStore $store): array => $store->staleUserIds($now, $limit));
    }

    public function announcedReachableUserIds(int $afterUserId, int $limit): array
    {
        return $this->run(fn (PresenceStore $store): array => $store->announcedReachableUserIds($afterUserId, $limit));
    }

    /**
     * @template T
     *
     * @param  callable(PresenceStore): T  $call
     * @return T
     */
    private function run(callable $call): mixed
    {
        $until = $this->downUntil();

        if ($until !== null && now()->getTimestamp() < $until) {
            return $call($this->fallback);
        }

        $this->redisDownUntil = null;

        try {
            return $call($this->primary);
        } catch (PresenceStoreUnavailable $exception) {
            $this->markDown(now()->getTimestamp() + $this->cooldownSeconds);

            Log::warning('Presence: Redis is unavailable, the database store answers instead.', [
                'error' => $exception->getPrevious()?->getMessage() ?? $exception->getMessage(),
                'retry_after_seconds' => $this->cooldownSeconds,
            ]);

            return $call($this->fallback);
        }
    }

    /** When the cooldown ends: this object's own memory first, else what another request of this server left in the shared cache. */
    private function downUntil(): ?int
    {
        if ($this->redisDownUntil !== null) {
            return $this->redisDownUntil;
        }

        try {
            $stored = $this->shared?->get(self::COOLDOWN_KEY);
        } catch (Throwable) {
            return null;
        }

        return is_int($stored) ? $stored : null;
    }

    private function markDown(int $until): void
    {
        $this->redisDownUntil = $until;

        if ($this->shared === null || $this->cooldownSeconds <= 0) {
            return;
        }

        try {
            $this->shared->put(self::COOLDOWN_KEY, $until, $this->cooldownSeconds);
        } catch (Throwable) {
            // Best effort: without it the next request asks Redis (and logs) again.
        }
    }
}
