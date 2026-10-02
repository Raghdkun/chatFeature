<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Stores\FailoverPresenceStore;
use App\Models\AgentPresence;
use Illuminate\Support\Facades\DB;
use Tests\Support\UsesPresenceRedis;

/** The same behaviour on the Redis store (skipped when no local Redis answers), plus what only Redis promises: no SQL for a heartbeat. */
class RedisPresenceBehaviourTest extends PresenceBehaviourTestCase
{
    use UsesPresenceRedis;

    protected function configureStore(): void
    {
        $this->usePresenceRedis();
    }

    protected function tearDown(): void
    {
        if ($this->app !== null) {
            $this->forgetTrackedPresenceUsers($this->app->make(PresenceStore::class));
        }

        parent::tearDown();
    }

    public function test_the_active_store_is_redis_wrapped_in_the_failover(): void
    {
        $this->assertInstanceOf(FailoverPresenceStore::class, app(PresenceStore::class));
    }

    public function test_a_heartbeat_makes_no_presence_sql_at_all(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $statements = [];
        DB::listen(function ($query) use (&$statements): void {
            $statements[] = $query->sql;
        });

        $this->elapse(30);
        $this->beat($this->agent, true);
        $this->elapse(60);
        $this->beat($this->agent, false);

        $presenceStatements = array_filter($statements, static fn (string $sql): bool => str_contains($sql, 'agent_presence'));
        $this->assertSame([], array_values($presenceStatements));
    }

    public function test_the_mirror_row_follows_the_effective_status(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $this->agent->id)->sole()->effective_status);

        $this->elapse(95);
        $this->sweep();

        $this->assertSame(PresenceStatus::Offline, AgentPresence::query()->where('user_id', $this->agent->id)->sole()->effective_status);
    }
}
