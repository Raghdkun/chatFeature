<?php

namespace Tests\Support;

use App\Domain\Presence\AvailableAgents;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\EffectivePresence;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\PresenceService;
use App\Domain\Presence\PresenceSweep;
use Illuminate\Support\Facades\Redis;
use Tests\TestCase;
use Throwable;

/**
 * Points the presence store at a local Redis for ONE test: connection `presence_test` on database index 15 and the key prefix
 * `presence-test:`, so nothing a developer keeps in Redis is read or touched (and nothing is ever flushed: the users a test used are
 * forgotten one by one). The test is skipped, not failed, when Redis cannot be reached.
 *
 * @mixin TestCase
 */
trait UsesPresenceRedis
{
    /** @var list<int> */
    private array $presenceUsersToForget = [];

    protected function usePresenceRedis(): void
    {
        config([
            'database.redis.presence_test' => array_merge((array) config('database.redis.default'), ['database' => '15']),
            'presence.store' => 'redis',
            'presence.redis.connection' => 'presence_test',
            'presence.redis.prefix' => 'presence-test:',
        ]);
        $this->app->forgetInstance('redis');
        Redis::clearResolvedInstance('redis');
        $this->resetPresenceServices();

        try {
            Redis::connection('presence_test')->ping();
        } catch (Throwable $exception) {
            $this->markTestSkipped('Redis is not reachable for the presence tests ('.$exception->getMessage().').');
        }
    }

    /** The presence singletons read `config('presence.*')` when first used: drop them after a test changed it. */
    protected function resetPresenceServices(): void
    {
        foreach ([PresenceStore::class, PresencePolicy::class, EffectivePresence::class, AvailableAgents::class, PresenceService::class, PresenceSweep::class] as $abstract) {
            $this->app->forgetInstance($abstract);
        }
    }

    /** Remember users whose Redis records must be dropped when the test ends. */
    protected function trackPresenceUsers(int ...$userIds): void
    {
        array_push($this->presenceUsersToForget, ...$userIds);
    }

    protected function forgetTrackedPresenceUsers(PresenceStore $store): void
    {
        foreach (array_unique($this->presenceUsersToForget) as $userId) {
            $store->forget($userId);
        }

        $this->presenceUsersToForget = [];
    }
}
