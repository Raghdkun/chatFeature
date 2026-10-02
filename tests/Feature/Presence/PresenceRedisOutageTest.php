<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Presence\Contracts\PresenceStore;
use App\Domain\Presence\Stores\FailoverPresenceStore;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Log;
use Tests\Support\ChatFixtures;
use Tests\Support\UsesPresenceRedis;
use Tests\TestCase;

/**
 * The failure mode, end to end: `presence.store = redis` with a Redis that cannot be reached (nothing listens on the port). No
 * presence endpoint, availability answer or sweep fails: the database store answers, with one warning in the log per cooldown. Needs no
 * running Redis.
 */
class PresenceRedisOutageTest extends TestCase
{
    use ChatFixtures, RefreshDatabase, UsesPresenceRedis;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'database.redis.presence_down' => ['host' => '127.0.0.1', 'port' => '1', 'database' => '0', 'password' => null, 'username' => null, 'timeout' => 0.3, 'max_retries' => 0],
            'presence.store' => 'redis',
            'presence.redis.connection' => 'presence_down',
            'presence.failure_cooldown_seconds' => 15,
        ]);
        $this->app->forgetInstance('redis');
        $this->resetPresenceServices();
        $this->travelTo(CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC'));

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = User::factory()->agent()->create();
        $this->billing->users()->attach($this->agent->id);
    }

    private function presenceStatus(): string
    {
        return (string) $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertOk()->json('data.status');
    }

    private function online(): bool
    {
        return (bool) $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/availability')->assertOk()->json('data.online');
    }

    public function test_the_store_is_redis_with_a_database_fallback(): void
    {
        $this->assertInstanceOf(FailoverPresenceStore::class, app(PresenceStore::class));
    }

    public function test_every_presence_endpoint_keeps_working_on_the_database_while_redis_is_down(): void
    {
        Log::spy();
        Event::fake([PresenceChanged::class]);

        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online', 'automatic' => true])
            ->assertOk()->assertJsonPath('data.status', 'online')->assertJsonPath('data.isManual', false);
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', ['visible' => false])->assertNoContent();
        $this->assertSame('online', $this->presenceStatus());
        $this->assertTrue($this->online());
        $this->artisan('chat:presence-sweep')->assertSuccessful();

        // The agent's state lives in the table meanwhile, so auto-away and the sweep still work.
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->where('user_id', $this->agent->id)->sole()->effective_status);
        foreach ([60, 120, 180, 240, 300] as $second) {
            $this->travelTo(CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC')->addSeconds($second));
            $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', ['visible' => false])->assertNoContent();
        }

        $this->assertSame('away', $this->presenceStatus());
        $this->travel(200)->seconds();
        $this->artisan('chat:presence-sweep')->assertSuccessful();
        $this->assertSame('offline', $this->presenceStatus());
        $this->assertFalse($this->online());

        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->status === PresenceStatus::Offline);
        Log::shouldHaveReceived('warning')->withArgs(fn (string $message): bool => str_contains($message, 'Redis is unavailable'))->atLeast()->once();
    }

    public function test_the_next_heartbeat_restores_an_agent_from_the_mirror_row(): void
    {
        // What Redis mirrored at the last change: online, pinned. Redis then went away, and the table is all there is.
        AgentPresence::query()->create([
            'user_id' => $this->agent->id,
            'status' => PresenceStatus::Online,
            'is_manual' => true,
            'last_seen_at' => now()->subMinutes(10),
            'last_heartbeat_at' => now()->subMinutes(10),
            'last_visible_at' => now()->subMinutes(10),
            'effective_status' => PresenceStatus::Online,
        ]);

        $this->assertSame('offline', $this->presenceStatus(), 'the mirror heartbeat is old: nobody has heard from the dashboard');

        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', ['visible' => true])->assertNoContent();

        $this->assertSame('online', $this->presenceStatus());
        $this->assertTrue($this->online());
    }
}
