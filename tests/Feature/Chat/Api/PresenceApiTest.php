<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\PresenceChanged;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `GET/PUT /me/presence` and `POST /me/presence/heartbeat`, and how presence feeds the public availability endpoint.
 */
class PresenceApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = User::factory()->agent()->create();
        $this->billing->users()->attach($this->agent->id);
    }

    private function availability(): array
    {
        return $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/availability')->assertOk()->json('data');
    }

    public function test_a_new_agent_is_offline(): void
    {
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')
            ->assertOk()
            ->assertExactJson(['data' => ['userId' => $this->agent->id, 'status' => 'offline', 'isManual' => false, 'lastSeenAt' => null]]);
        $this->assertSame(0, AgentPresence::query()->count());
    }

    public function test_the_agent_sets_their_status(): void
    {
        Event::fake([PresenceChanged::class]);

        $response = $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])
            ->assertOk()
            ->assertJsonPath('data.status', 'online')
            ->assertJsonPath('data.isManual', true)
            ->assertJsonPath('data.userId', $this->agent->id);
        $this->assertNotNull($response->json('data.lastSeenAt'));

        $row = AgentPresence::query()->sole();
        $this->assertSame(PresenceStatus::Online, $row->status);
        $this->assertTrue($row->is_manual);
        $this->assertNotNull($row->last_heartbeat_at);
        Event::assertDispatchedTimes(PresenceChanged::class, 1);
        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->userId === $this->agent->id && $event->status === PresenceStatus::Online);

        // The same status again changes nothing and says nothing; a different one is announced.
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])->assertOk();
        Event::assertDispatchedTimes(PresenceChanged::class, 1);
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'away'])->assertOk()->assertJsonPath('data.status', 'away');
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'offline'])->assertOk()->assertJsonPath('data.status', 'offline');
        Event::assertDispatchedTimes(PresenceChanged::class, 3);
        $this->assertSame(1, AgentPresence::query()->count());

        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'offline');
    }

    public function test_the_status_is_validated(): void
    {
        foreach ([[], ['status' => 'busy'], ['status' => ''], ['status' => ['online']]] as $body) {
            $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', $body)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['status']]]);
        }
    }

    public function test_the_heartbeat_keeps_an_agent_present_and_a_silent_one_drops_out_after_90_seconds(): void
    {
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])->assertOk();

        $this->travel(80)->seconds();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'online');
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat')->assertNoContent();

        $this->travel(80)->seconds();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'online');

        // Silence for longer than the window: effectively offline, though the stored status still says online.
        $this->travel(11)->seconds();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'offline');
        $this->assertSame(PresenceStatus::Online, AgentPresence::query()->sole()->status);

        // The minute sweep announces the silence (clients are told once); a heartbeat then brings them back and announces that.
        $this->artisan('chat:presence-sweep')->assertSuccessful();
        Event::fake([PresenceChanged::class]);
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat')->assertNoContent();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'online');
        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->status === PresenceStatus::Online);
    }

    public function test_a_heartbeat_never_turns_an_offline_agent_online(): void
    {
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat')->assertNoContent();
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.status', 'offline');

        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'offline'])->assertOk();
        $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat')->assertNoContent();
        $this->assertNull(AgentPresence::query()->sole()->last_heartbeat_at);
    }

    public function test_presence_needs_a_signed_in_member_of_staff(): void
    {
        $this->getJson('/api/v1/me/presence')->assertUnauthorized();
        $this->putJson('/api/v1/me/presence', ['status' => 'online'])->assertUnauthorized();
        $this->postJson('/api/v1/me/presence/heartbeat')->assertUnauthorized();

        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->getJson('/api/v1/me/presence')->assertForbidden();
    }

    public function test_an_agent_going_online_makes_the_widget_available_at_once_and_going_offline_takes_it_away(): void
    {
        $before = $this->availability();
        $this->assertFalse($before['online']);
        $this->assertTrue($before['openNow']);
        $this->assertSame([['slug' => 'billing', 'online' => false]], $before['categories']);

        // The answer was cached for a few seconds; the presence change drops it.
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])->assertOk();
        $online = $this->availability();
        $this->assertTrue($online['online']);
        $this->assertSame([['slug' => 'billing', 'online' => true]], $online['categories']);

        // Online and away are both reachable: switching between them does not change the answer.
        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'away'])->assertOk();
        $this->assertTrue($this->availability()['online']);

        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'offline'])->assertOk();
        $this->assertFalse($this->availability()['online']);
    }

    public function test_availability_counts_only_agents_who_can_take_a_chat(): void
    {
        $other = Category::factory()->create(['slug' => 'sales']);
        $this->widget->categories()->attach($other->id, ['sort_order' => 1]);
        $this->availableAgent($other, ['is_active' => true]);
        $this->assertSame([['slug' => 'billing', 'online' => false], ['slug' => 'sales', 'online' => true]], $this->availability()['categories']);

        $this->travel(9)->seconds();
        $busy = $this->availableAgent($this->billing, ['max_concurrent_chats' => 1]);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $busy);
        $this->assertSame([['slug' => 'billing', 'online' => false], ['slug' => 'sales', 'online' => true]], $this->availability()['categories']);

        $this->travel(9)->seconds();
        $stale = $this->availableAgent($this->billing);
        $this->setPresence($stale, PresenceStatus::Online, heartbeatSecondsAgo: 120);
        $this->assertFalse($this->availability()['categories'][0]['online']);

        $this->travel(9)->seconds();
        $this->availableAgent($this->billing);
        $this->assertTrue($this->availability()['categories'][0]['online']);

        // Closed hours win over any number of agents.
        $this->widget->forceFill(['offline_mode' => 'always_offline'])->save();
        $this->travel(9)->seconds();
        $this->assertFalse($this->availability()['online']);
    }

    public function test_an_account_that_does_not_take_chats_never_counts(): void
    {
        $admin = User::factory()->admin()->create(['is_agent' => false]);
        $this->billing->users()->attach($admin->id);

        $this->actingAs($admin, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online'])->assertOk()->assertJsonPath('data.status', 'online');

        $this->assertFalse($this->availability()['online']);
    }
}
