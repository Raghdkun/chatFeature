<?php

namespace App\Domain\Presence\Stores;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Exceptions\PresenceStoreUnavailable;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\PresenceRecord;
use App\Domain\Presence\PresenceTransition;
use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Redis\Connections\Connection;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Presence kept in Redis (decision P5-D1; needs the phpredis client, the default `REDIS_CLIENT`). One hash per user, `{prefix}{id}` (`status`, `manual`, `visible`, `last_heartbeat_at`,
 * `last_visible_at`, `last_seen_at`, `announced`), expiring `2 x heartbeat window` after the last sign of life, and one sorted set
 * `{prefix}alive` scored by the last heartbeat (the sweep's range query for silent users).
 *
 * A heartbeat is ONE Lua call (atomic, O(1), no SQL): it refreshes the hash and the set, then the effective status is worked out here
 * from what the script returned. Only when that differs from `announced` is a second tiny script run to claim the change (the caller that
 * moves `announced` is the one that reports it) and the `agent_presence` mirror written, so a steady stream of heartbeats costs no SQL
 * and no events. Any Redis failure surfaces as `PresenceStoreUnavailable`; the mirror write failing is logged and swallowed (the
 * database is a mirror here, and the next real change or sweep rewrites it).
 */
final class RedisPresenceStore implements PresenceStore
{
    /** KEYS: hash, alive. ARGV: user id, status, manual, now, ttl, available (0|1). Returns the hash (a fresh one when the old life was over). */
    private const CHOOSE = <<<'LUA'
local last = math.max(tonumber(redis.call('HGET', KEYS[1], 'last_heartbeat_at') or '0'), tonumber(redis.call('HGET', KEYS[1], 'last_seen_at') or '0'))
if last > 0 and tonumber(ARGV[4]) - last >= tonumber(ARGV[5]) then
  redis.call('DEL', KEYS[1])
end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'manual', ARGV[3], 'last_seen_at', ARGV[4])
if ARGV[6] == '1' then
  redis.call('HSET', KEYS[1], 'last_heartbeat_at', ARGV[4], 'last_visible_at', ARGV[4], 'visible', '1')
  redis.call('ZADD', KEYS[2], ARGV[4], ARGV[1])
else
  redis.call('ZREM', KEYS[2], ARGV[1])
end
redis.call('EXPIRE', KEYS[1], ARGV[5])
return redis.call('HGETALL', KEYS[1])
LUA;

    /**
     * KEYS: hash, alive. ARGV: user id, now, visible (0|1), ttl. A record whose life is over is removed; a stored `offline` keeps its status
     * and its heartbeat time (a heartbeat never turns it on) but still notes that a tab is open and whether it is visible (so the
     * dashboard-visibility check is truthful for an agent who chose Offline) and keeps the record alive. Returns the hash as it is
     * afterwards (empty when there is none).
     */
    private const BEAT = <<<'LUA'
local last = math.max(tonumber(redis.call('HGET', KEYS[1], 'last_heartbeat_at') or '0'), tonumber(redis.call('HGET', KEYS[1], 'last_seen_at') or '0'))
if last == 0 or tonumber(ARGV[2]) - last >= tonumber(ARGV[4]) then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  return {}
end
local status = redis.call('HGET', KEYS[1], 'status')
if status ~= 'offline' then
  redis.call('HSET', KEYS[1], 'last_heartbeat_at', ARGV[2], 'last_seen_at', ARGV[2], 'visible', ARGV[3])
  if ARGV[3] == '1' then
    redis.call('HSET', KEYS[1], 'last_visible_at', ARGV[2])
  end
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
else
  redis.call('HSET', KEYS[1], 'last_seen_at', ARGV[2], 'visible', ARGV[3])
  if ARGV[3] == '1' then
    redis.call('HSET', KEYS[1], 'last_visible_at', ARGV[2])
  end
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return redis.call('HGETALL', KEYS[1])
LUA;

    /** KEYS: hash. ARGV: the effective status. 1 when THIS call moved `announced` (it then owns telling everybody), else 0. */
    private const ANNOUNCE = <<<'LUA'
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 0
end
if redis.call('HGET', KEYS[1], 'announced') == ARGV[1] then
  return 0
end
redis.call('HSET', KEYS[1], 'announced', ARGV[1])
return 1
LUA;

    public function __construct(
        private readonly RedisFactory $redis,
        private readonly PresencePolicy $policy,
        private readonly PresenceMirror $mirror,
        private readonly string $connection = 'default',
        private readonly string $prefix = 'presence:',
    ) {}

    public function find(int $userId, CarbonInterface $now): ?PresenceRecord
    {
        return $this->live($this->read([$userId])[$userId] ?? null, $now);
    }

    public function findMany(array $userIds, CarbonInterface $now): array
    {
        $records = [];

        foreach ($this->read($userIds) as $userId => $record) {
            $record = $this->live($record, $now);

            if ($record !== null) {
                $records[$userId] = $record;
            }
        }

        return $records;
    }

    public function choose(int $userId, PresenceStatus $status, bool $manual, CarbonInterface $now): PresenceTransition
    {
        $raw = $this->script(self::CHOOSE, [$this->key($userId), $this->aliveKey()], [
            $userId, $status->value, $manual ? '1' : '0', $now->getTimestamp(), $this->policy->lifetimeSeconds(), $status->isAvailable() ? '1' : '0',
        ]);

        return $this->settle($userId, $this->record($userId, $this->hash($raw)), $now, false);
    }

    public function beat(int $userId, bool $visible, CarbonInterface $now): PresenceTransition
    {
        $raw = $this->script(self::BEAT, [$this->key($userId), $this->aliveKey()], [
            $userId, $now->getTimestamp(), $visible ? '1' : '0', $this->policy->lifetimeSeconds(),
        ]);

        return $this->settle($userId, $this->record($userId, $this->hash($raw)), $now, false);
    }

    public function reconcile(int $userId, CarbonInterface $now): PresenceTransition
    {
        $record = $this->live($this->read([$userId])[$userId] ?? null, $now);
        $this->syncAlive($userId, $record, $now);

        return $this->settle($userId, $record, $now, true);
    }

    public function forget(int $userId): void
    {
        $this->call(function (Connection $redis) use ($userId): void {
            $redis->del($this->key($userId));
            $redis->zrem($this->aliveKey(), (string) $userId);
        });
    }

    public function staleUserIds(CarbonInterface $now, int $limit): array
    {
        $cutoff = $now->getTimestamp() - $this->policy->windowSeconds();
        $members = $this->call(fn (Connection $redis): mixed => $redis->zrangebyscore($this->aliveKey(), '-inf', '('.$cutoff, ['limit' => [0, $limit]]));

        return array_values(array_map(intval(...), $members));
    }

    public function announcedReachableUserIds(int $afterUserId, int $limit): array
    {
        return $this->mirror->announcedReachableUserIds($afterUserId, $limit);
    }

    /**
     * Works out the effective status and, when it differs from what clients were last told, claims the change and mirrors it. `$sweep`
     * allows reading the mirror (SQL) to learn what was announced when Redis no longer remembers; the heartbeat path never does.
     */
    private function settle(int $userId, ?PresenceRecord $record, CarbonInterface $now, bool $sweep): PresenceTransition
    {
        $after = $this->policy->effective($record, $now);
        $before = $record->announced ?? ($sweep ? $this->mirror->announced($userId) : null) ?? PresenceStatus::Offline;

        if ($after === $before) {
            return new PresenceTransition($userId, $before, $after, $record);
        }

        if ($record === null) {
            // Nothing in Redis to claim the change on: the mirror row is the memory, and it is moved only if it still says what we saw.
            $moved = $this->guarded(fn (): bool => $this->mirror->markOffline($userId, $before));

            return new PresenceTransition($userId, $before, $moved === true ? $after : $before, null);
        }

        $claimed = $this->script(self::ANNOUNCE, [$this->key($userId)], [$after->value]);

        if ((int) $claimed !== 1) {
            return new PresenceTransition($userId, $after, $after, $record);
        }

        $this->guarded(fn () => $this->mirror->write($record, $after, $now));

        return new PresenceTransition($userId, $before, $after, $record->withAnnounced($after));
    }

    /** Keeps the `alive` set in step with the record: a member is a user whose record could still be fresh (the score is the last heartbeat). */
    private function syncAlive(int $userId, ?PresenceRecord $record, CarbonInterface $now): void
    {
        $this->call(function (Connection $redis) use ($userId, $record, $now): void {
            if ($record !== null && $record->status->isAvailable() && $this->policy->isFresh($record->heartbeatAt, $now)) {
                $redis->zadd($this->aliveKey(), (int) $record->heartbeatAt?->getTimestamp(), (string) $userId);
            } else {
                $redis->zrem($this->aliveKey(), (string) $userId);
            }
        });
    }

    /**
     * @param  list<int>  $userIds
     * @return array<int, PresenceRecord|null>
     */
    private function read(array $userIds): array
    {
        if ($userIds === []) {
            return [];
        }

        $results = $this->call(function (Connection $redis) use ($userIds): array {
            if (count($userIds) === 1) {
                return [$redis->hgetall($this->key($userIds[0]))];
            }

            $pipe = $redis->pipeline();

            foreach ($userIds as $userId) {
                $pipe->hgetall($this->key($userId));
            }

            return $pipe->exec();
        });

        $records = [];

        foreach ($userIds as $index => $userId) {
            $records[$userId] = $this->record($userId, $this->hash($results[$index] ?? []));
        }

        return $records;
    }

    private function live(?PresenceRecord $record, CarbonInterface $now): ?PresenceRecord
    {
        if ($record === null) {
            return null;
        }

        $activity = $record->activityAt();

        return $activity !== null && $now->getTimestamp() - $activity->getTimestamp() < $this->policy->lifetimeSeconds() ? $record : null;
    }

    /**
     * @param  array<string, string>  $hash
     */
    private function record(int $userId, array $hash): ?PresenceRecord
    {
        if ($hash === []) {
            return null;
        }

        return new PresenceRecord(
            userId: $userId,
            status: PresenceStatus::tryFrom($hash['status'] ?? '') ?? PresenceStatus::Offline,
            manual: ($hash['manual'] ?? '0') === '1',
            heartbeatAt: $this->moment($hash['last_heartbeat_at'] ?? null),
            visibleAt: $this->moment($hash['last_visible_at'] ?? null),
            seenAt: $this->moment($hash['last_seen_at'] ?? null),
            announced: PresenceStatus::tryFrom($hash['announced'] ?? ''),
        );
    }

    private function moment(?string $timestamp): ?CarbonImmutable
    {
        return $timestamp === null || $timestamp === '' ? null : CarbonImmutable::createFromTimestamp((int) $timestamp);
    }

    /**
     * Redis answers HGETALL as an associative array (a pipelined call) or as a flat list (a script).
     *
     * @return array<string, string>
     */
    private function hash(mixed $raw): array
    {
        if (! is_array($raw) || $raw === []) {
            return [];
        }

        if (! array_is_list($raw)) {
            return array_map(strval(...), $raw);
        }

        $hash = [];

        for ($index = 0; $index + 1 < count($raw); $index += 2) {
            $hash[(string) $raw[$index]] = (string) $raw[$index + 1];
        }

        return $hash;
    }

    /**
     * Runs a Lua script (phpredis form: the keys first, then the other arguments).
     *
     * @param  list<string>  $keys
     * @param  list<int|string>  $arguments
     */
    private function script(string $script, array $keys, array $arguments): mixed
    {
        return $this->call(fn (Connection $redis): mixed => $redis->command('eval', [$script, [...$keys, ...$arguments], count($keys)]));
    }

    /**
     * @template T
     *
     * @param  callable(Connection): T  $command
     * @return T
     *
     * @throws PresenceStoreUnavailable
     */
    private function call(callable $command): mixed
    {
        try {
            return $command($this->redis->connection($this->connection));
        } catch (Throwable $exception) {
            throw PresenceStoreUnavailable::because($exception);
        }
    }

    /**
     * Runs a mirror (SQL) step; a failure is logged and returns null instead of failing the heartbeat that triggered it.
     *
     * @template T
     *
     * @param  callable(): T  $step
     * @return T|null
     */
    private function guarded(callable $step): mixed
    {
        try {
            return $step();
        } catch (Throwable $exception) {
            Log::error('The presence mirror (agent_presence) could not be written; Redis stays the source of truth.', ['error' => $exception->getMessage()]);

            return null;
        }
    }

    private function key(int $userId): string
    {
        return $this->prefix.$userId;
    }

    private function aliveKey(): string
    {
        return $this->prefix.'alive';
    }
}
