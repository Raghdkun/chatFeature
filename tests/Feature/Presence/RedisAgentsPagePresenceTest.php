<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\PresenceService;
use Illuminate\Support\Facades\DB;

/** The agents page on the Redis store: the same, and its presence read makes no presence SQL at all. */
class RedisAgentsPagePresenceTest extends AgentsPagePresenceTest
{
    protected function configureStore(): void
    {
        $this->usePresenceRedis();
    }

    public function test_the_page_makes_no_agent_presence_query(): void
    {
        $admin = $this->staff('admin');
        app(PresenceService::class)->set($this->staff(), PresenceStatus::Online);
        $statements = [];
        DB::listen(function ($query) use (&$statements): void {
            $statements[] = $query->sql;
        });

        $this->actingAs($admin)->get('/agents')->assertOk();

        $this->assertSame([], array_values(array_filter($statements, static fn (string $sql): bool => str_contains($sql, 'agent_presence'))));
    }
}
