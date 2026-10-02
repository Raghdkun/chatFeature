<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\Stores\RedisPresenceStore;
use App\Models\AgentPresence;
use Illuminate\Contracts\Redis\Factory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use Tests\Support\PresenceStoreContract;
use Tests\Support\UsesPresenceRedis;
use Tests\TestCase;

/**
 * The Redis store against a real local Redis (database index 15, prefix `presence-test:`; skipped when Redis is not reachable): the
 * contract every store keeps, plus what is special to it (no SQL for a heartbeat, a mirror row only when the status changes, records that
 * expire, the heartbeat set).
 */
class RedisPresenceStoreTest extends TestCase
{
    use PresenceStoreContract, RefreshDatabase, UsesPresenceRedis;

    protected function makeStore(): PresenceStore
    {
        return new RedisPresenceStore($this->app->make(Factory::class), new PresencePolicy(90, 5), new PresenceMirror, 'presence_test', 'presence-test:');
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->usePresenceRedis();
        $this->store = $this->makeStore();
    }

    protected function tearDown(): void
    {
        if (isset($this->store)) {
            $this->forgetTrackedPresenceUsers($this->store);
        }

        parent::tearDown();
    }

    /** @return list<string> the SQL statements a callback ran */
    private function queriesDuring(callable $work): array
    {
        $queries = [];
        DB::listen(function ($query) use (&$queries): void {
            $queries[] = $query->sql;
        });
        $work();

        return $queries;
    }

    public function test_a_steady_heartbeat_makes_no_sql_query(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $queries = $this->queriesDuring(function () use ($id): void {
            foreach ([30, 60, 90, 120] as $second) {
                $this->assertFalse($this->store->beat($id, $second % 60 === 0, $this->at($second))->changed());
            }
        });

        $this->assertSame([], $queries);
    }

    public function test_a_read_of_many_users_makes_no_sql_query(): void
    {
        $ids = [$this->agentId(), $this->agentId(), $this->agentId()];
        $this->store->choose($ids[0], PresenceStatus::Online, true, $this->at(0));

        $this->assertSame([], $this->queriesDuring(fn () => $this->store->findMany($ids, $this->at(1))));
    }

    public function test_the_mirror_row_is_written_when_the_effective_status_changes_and_not_otherwise(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));

        $row = AgentPresence::query()->where('user_id', $id)->sole();
        $this->assertSame(PresenceStatus::Online, $row->effective_status);
        $this->assertSame(PresenceStatus::Online, $row->status);
        $this->assertFalse($row->is_manual);
        $this->assertSame($this->at(0)->getTimestamp(), $row->last_heartbeat_at?->getTimestamp());

        $writes = $this->queriesDuring(function () use ($id): void {
            foreach ([60, 120, 180, 240] as $second) {
                $this->store->beat($id, false, $this->at($second));
            }
        });
        $this->assertSame([], $writes);
        $this->assertSame($this->at(0)->getTimestamp(), AgentPresence::query()->where('user_id', $id)->sole()->last_heartbeat_at?->getTimestamp(), 'the mirror keeps the heartbeat of the last change');

        $this->store->beat($id, false, $this->at(300));
        $this->assertSame(PresenceStatus::Away, AgentPresence::query()->where('user_id', $id)->sole()->effective_status);
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $id)->sole()->status, 'the mirror still says what the agent chose');
    }

    public function test_a_record_lives_two_windows_after_its_last_sign_of_life_and_a_late_heartbeat_does_not_revive_it(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $this->assertNotNull($this->store->find($id, $this->at(179)));
        $this->assertNull($this->store->find($id, $this->at(180)));

        $late = $this->store->beat($id, true, $this->at(181));

        $this->assertFalse($late->changed(), 'the sweep announces the silence, not the late heartbeat');
        $this->assertNull($this->store->find($id, $this->at(182)));
        $this->assertSame(PresenceStatus::Offline, $this->store->reconcile($id, $this->at(183))->after);
    }

    public function test_the_hash_expires_in_redis_itself(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $ttl = (int) Redis::connection('presence_test')->ttl('presence-test:'.$id);

        $this->assertGreaterThan(0, $ttl);
        $this->assertLessThanOrEqual(180, $ttl);
    }

    public function test_silent_users_are_found_by_the_range_query_on_the_heartbeat_set_in_batches(): void
    {
        [$a, $b, $c] = [$this->agentId(), $this->agentId(), $this->agentId()];
        $this->store->choose($a, PresenceStatus::Online, true, $this->at(0));
        $this->store->choose($b, PresenceStatus::Online, true, $this->at(10));
        $this->store->choose($c, PresenceStatus::Online, true, $this->at(100));

        $this->assertSame([], $this->store->staleUserIds($this->at(90), 10));
        $this->assertSame([$a], $this->store->staleUserIds($this->at(95), 10));
        $this->assertEqualsCanonicalizing([$a, $b], $this->store->staleUserIds($this->at(101), 10));
        $this->assertCount(1, $this->store->staleUserIds($this->at(101), 1));

        $this->store->reconcile($a, $this->at(101));
        $this->assertSame([$b], $this->store->staleUserIds($this->at(101), 10));
    }

    public function test_a_heartbeat_that_loses_the_race_to_announce_reports_no_change(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, false, $this->at(0));

        foreach ([60, 120, 180, 240] as $second) {
            $this->store->beat($id, false, $this->at($second));
        }

        // Another process has already announced `away` when this one gets there.
        Redis::connection('presence_test')->hset('presence-test:'.$id, 'announced', 'away');
        $beat = $this->store->beat($id, false, $this->at(300));

        $this->assertFalse($beat->changed());
        $this->assertSame(PresenceStatus::Away, $beat->after);
    }

    public function test_it_uses_its_own_prefix(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));

        $this->assertSame(1, (int) Redis::connection('presence_test')->exists('presence-test:'.$id));
        $this->assertSame(0, (int) Redis::connection('presence_test')->exists('presence:'.$id));
    }

    public function test_a_user_redis_lost_is_announced_offline_from_the_mirror_by_the_sweep(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        $this->assertSame([$id], $this->store->announcedReachableUserIds(0, 10));

        // A Redis restart or flush: the hash and the heartbeat set are gone, the mirror row still says `online`.
        $this->store->forget($id);

        $gone = $this->store->reconcile($id, $this->at(10));

        $this->assertSame([PresenceStatus::Online, PresenceStatus::Offline], [$gone->before, $gone->after]);
        $this->assertSame(PresenceStatus::Offline, AgentPresence::query()->where('user_id', $id)->sole()->effective_status);
        $this->assertFalse($this->store->reconcile($id, $this->at(11))->changed());
        $this->assertSame([], $this->store->announcedReachableUserIds(0, 10));
    }

    public function test_a_lost_mirror_write_is_repaired_by_the_next_change(): void
    {
        $id = $this->agentId();
        $this->store->choose($id, PresenceStatus::Online, true, $this->at(0));
        AgentPresence::query()->where('user_id', $id)->delete();

        $this->store->reconcile($id, $this->at(91));

        $this->assertSame(PresenceStatus::Offline, AgentPresence::query()->where('user_id', $id)->sole()->effective_status);
    }
}
