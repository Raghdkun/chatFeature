<?php

namespace App\Providers;

use App\Domain\Notifications\Contracts\DashboardVisibility;
use App\Domain\Presence\AvailableAgents;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\DatabasePresenceReader;
use App\Domain\Presence\EffectivePresence;
use App\Domain\Presence\PresenceDashboardVisibility;
use App\Domain\Presence\PresenceMirror;
use App\Domain\Presence\PresencePolicy;
use App\Domain\Presence\PresenceService;
use App\Domain\Presence\PresenceSweep;
use App\Domain\Presence\Stores\DatabasePresenceStore;
use App\Domain\Presence\Stores\FailoverPresenceStore;
use App\Domain\Presence\Stores\RedisPresenceStore;
use App\Domain\Widgets\Contracts\PresenceReader;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Contracts\Redis\Factory as RedisFactory;
use Illuminate\Support\ServiceProvider;

/**
 * Agent presence and availability (P4 minimal, P5: Redis store, auto-away, sweep).
 *
 * `PresenceStore` is the one place agents' live status is kept: Redis (`presence.store = redis`, wrapped so that an outage falls back
 * to the database) or the `agent_presence` table. Routing (`AvailableAgents`), the public availability (`PresenceReader`), the REST
 * endpoints, the roster and the agents page all read it through `EffectivePresence` / `PresenceService`. This provider is registered
 * before the Widgets one, whose `bindIf` default for `PresenceReader` (nobody online) then stays unused. Keep bindings and boot logic
 * for this bounded context here so parallel tracks never edit the same provider.
 */
class PresenceServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(PresencePolicy::class, fn (): PresencePolicy => PresencePolicy::fromConfig());
        $this->app->singleton(PresenceMirror::class);
        $this->app->singleton(PresenceStore::class, fn (Application $app): PresenceStore => $this->store($app));
        $this->app->singleton(EffectivePresence::class);
        $this->app->singleton(AvailableAgents::class);
        $this->app->singleton(PresenceService::class);
        $this->app->singleton(PresenceSweep::class);
        $this->app->bind(PresenceReader::class, DatabasePresenceReader::class);
        // The strict answer (a heartbeat that reported the tab visible); it wins over the notifications default.
        $this->app->bind(DashboardVisibility::class, PresenceDashboardVisibility::class);
    }

    public function boot(): void
    {
        //
    }

    private function store(Application $app): PresenceStore
    {
        $policy = $app->make(PresencePolicy::class);
        $mirror = $app->make(PresenceMirror::class);
        $database = new DatabasePresenceStore($policy, $mirror);

        if (config('presence.store') !== 'redis') {
            return $database;
        }

        return new FailoverPresenceStore(
            new RedisPresenceStore(
                $app->make(RedisFactory::class),
                $policy,
                $mirror,
                (string) config('presence.redis.connection', 'default'),
                (string) config('presence.redis.prefix', 'presence:'),
            ),
            $database,
            max(0, (int) config('presence.failure_cooldown_seconds', 15)),
        );
    }
}
