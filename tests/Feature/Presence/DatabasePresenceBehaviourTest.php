<?php

namespace Tests\Feature\Presence;

use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use Tests\Support\UsesPresenceRedis;

/** Presence behaviour on the database store (small installs, development, the Redis fallback). */
class DatabasePresenceBehaviourTest extends PresenceBehaviourTestCase
{
    use UsesPresenceRedis;

    protected function configureStore(): void
    {
        config(['presence.store' => 'database']);
        $this->resetPresenceServices();
    }

    public function test_the_active_store_is_the_database_one(): void
    {
        $this->assertInstanceOf(DatabasePresenceStore::class, app(PresenceStore::class));
    }
}
