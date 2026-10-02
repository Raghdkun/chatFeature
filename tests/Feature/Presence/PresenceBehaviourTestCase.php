<?php

namespace Tests\Feature\Presence;

use App\Domain\Chat\Actions\OfferToAgents;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\PresenceChanged;
use App\Domain\Chat\Jobs\OfferNextWave;
use App\Domain\Presence\AvailableAgents;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * Presence as the REST API, routing, the public availability and the sweep see it (decisions P5-D1..D3), written once and run against
 * each store: `DatabasePresenceBehaviourTest`, and `RedisPresenceBehaviourTest` when Redis is reachable.
 *
 * Time moves with `travelTo`: the stores take their instant from `now()`.
 */
abstract class PresenceBehaviourTestCase extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, RefreshDatabase;

    protected Widget $widget;

    protected Category $billing;

    protected User $agent;

    protected CarbonImmutable $start;

    /** Switch the presence store under test on (before anything resolves a presence service). */
    abstract protected function configureStore(): void;

    protected function setUp(): void
    {
        parent::setUp();

        $this->configureStore();
        $this->start = CarbonImmutable::parse('2026-10-01 12:00:00', 'UTC');
        $this->travelTo($this->start);

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->newAgent();
    }

    protected function newAgent(): User
    {
        $agent = User::factory()->agent()->create();
        $this->billing->users()->attach($agent->id);

        if (method_exists($this, 'trackPresenceUsers')) {
            $this->trackPresenceUsers($agent->id);
        }

        return $agent;
    }

    protected function elapse(int $seconds): void
    {
        $this->travelTo($this->start->addSeconds($seconds));
    }

    /** @param array<string, mixed> $body */
    protected function choose(User $agent, string $status, array $body = []): void
    {
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => $status] + $body)->assertOk();
    }

    protected function beat(User $agent, ?bool $visible = null): void
    {
        $this->actingAs($agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', $visible === null ? [] : ['visible' => $visible])->assertNoContent();
    }

    protected function statusOf(User $agent): string
    {
        return (string) $this->actingAs($agent, 'sanctum')->getJson('/api/v1/me/presence')->assertOk()->json('data.status');
    }

    protected function sweep(): void
    {
        $this->artisan('chat:presence-sweep')->assertSuccessful();
    }

    /** @return array<string, mixed> */
    protected function availability(): array
    {
        return $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/availability')->assertOk()->json('data');
    }

    /**
     * @param  list<PresenceStatus>  $statuses
     * @return list<int>
     */
    protected function routable(array $statuses): array
    {
        return app(AvailableAgents::class)->userIds($this->billing->id, $statuses);
    }

    // ---- the heartbeat endpoint -------------------------------------------------------------------------------------------

    public function test_the_heartbeat_payload_is_validated(): void
    {
        $this->choose($this->agent, 'online');

        foreach ([['visible' => 'maybe'], ['visible' => ['yes']], ['visible' => 2]] as $body) {
            $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', $body)
                ->assertStatus(422)
                ->assertJsonStructure(['error' => ['code', 'message', 'details' => ['visible']]]);
        }

        foreach ([[], ['visible' => true], ['visible' => false], ['visible' => 1], ['visible' => 0], ['visible' => '0'], ['visible' => null]] as $body) {
            $this->actingAs($this->agent, 'sanctum')->postJson('/api/v1/me/presence/heartbeat', $body)->assertNoContent();
        }
    }

    public function test_a_heartbeat_without_visible_counts_as_visible(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);

        // Seven minutes of beats that do not say anything about visibility (older clients): never away.
        for ($second = 60; $second <= 420; $second += 60) {
            $this->elapse($second);
            $this->beat($this->agent);
        }

        $this->assertSame('online', $this->statusOf($this->agent));
    }

    public function test_a_burst_of_heartbeats_announces_nothing_more(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);
        Event::fake([PresenceChanged::class]);

        for ($beat = 0; $beat < 25; $beat++) {
            $this->beat($this->agent, $beat % 2 === 0);
        }

        Event::assertNotDispatched(PresenceChanged::class);
        $this->assertSame('online', $this->statusOf($this->agent));
    }

    public function test_a_heartbeat_never_turns_an_offline_agent_online(): void
    {
        // No record at all.
        $this->beat($this->agent, true);
        $this->assertSame('offline', $this->statusOf($this->agent));

        // A status chosen as offline, with a visible tab beating.
        $this->choose($this->agent, 'online');
        $this->choose($this->agent, 'offline');
        Event::fake([PresenceChanged::class]);

        foreach ([10, 40, 70] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, true);
        }

        $this->assertSame('offline', $this->statusOf($this->agent));
        Event::assertNotDispatched(PresenceChanged::class);
        $this->assertSame([], $this->routable([PresenceStatus::Online, PresenceStatus::Away]));
    }

    public function test_the_heartbeat_needs_a_signed_in_member_of_staff(): void
    {
        $this->postJson('/api/v1/me/presence/heartbeat', ['visible' => true])->assertUnauthorized();
        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->postJson('/api/v1/me/presence/heartbeat')->assertForbidden();
    }

    // ---- auto-away --------------------------------------------------------------------------------------------------------

    public function test_an_automatic_agent_goes_away_after_five_hidden_minutes_and_online_again_on_a_visible_beat(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.isManual', false);
        Event::fake([PresenceChanged::class]);

        foreach ([60, 120, 180, 240, 299] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, false);
            $this->assertSame('online', $this->statusOf($this->agent), "hidden for {$second} s");
        }

        Event::assertNotDispatched(PresenceChanged::class);

        $this->elapse(300);
        $this->beat($this->agent, false);

        $this->assertSame('away', $this->statusOf($this->agent));
        Event::assertDispatchedTimes(PresenceChanged::class, 1);
        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->userId === $this->agent->id && $event->status === PresenceStatus::Away);

        $this->elapse(330);
        $this->beat($this->agent, false);
        Event::assertDispatchedTimes(PresenceChanged::class, 1);

        $this->elapse(360);
        $this->beat($this->agent, true);

        $this->assertSame('online', $this->statusOf($this->agent));
        Event::assertDispatchedTimes(PresenceChanged::class, 2);
        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->status === PresenceStatus::Online);
    }

    public function test_one_visible_tab_keeps_the_agent_online_while_another_stays_hidden(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);

        for ($second = 60; $second <= 900; $second += 60) {
            $this->elapse($second);
            $this->beat($this->agent, false);
            $this->beat($this->agent, $second % 120 === 0);
        }

        $this->assertSame('online', $this->statusOf($this->agent));
    }

    public function test_a_pinned_status_is_never_moved_by_hidden_tabs(): void
    {
        $this->choose($this->agent, 'online');
        $other = $this->newAgent();
        $this->choose($other, 'away');

        for ($second = 60; $second <= 1_200; $second += 60) {
            $this->elapse($second);
            $this->beat($this->agent, false);
            $this->beat($other, true);
        }

        $this->assertSame('online', $this->statusOf($this->agent));
        $this->assertSame('away', $this->statusOf($other), 'a visible tab does not turn a pinned away into online');
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.isManual', true);
    }

    public function test_automatic_only_applies_to_online(): void
    {
        $this->choose($this->agent, 'away', ['automatic' => true]);
        $this->actingAs($this->agent, 'sanctum')->getJson('/api/v1/me/presence')->assertJsonPath('data.isManual', true)->assertJsonPath('data.status', 'away');

        $this->actingAs($this->agent, 'sanctum')->putJson('/api/v1/me/presence', ['status' => 'online', 'automatic' => 'sometimes'])->assertStatus(422);
    }

    public function test_the_agent_who_left_the_dashboard_is_offline_after_the_window_and_the_sweep_says_so_once(): void
    {
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertTrue($this->availability()['online']);
        Event::fake([PresenceChanged::class]);

        $this->elapse(91);
        $this->assertSame('offline', $this->statusOf($this->agent));
        $this->sweep();
        $this->sweep();

        Event::assertDispatchedTimes(PresenceChanged::class, 1);
        Event::assertDispatched(PresenceChanged::class, fn (PresenceChanged $event): bool => $event->status === PresenceStatus::Offline);
        $this->elapse(100);
        $this->assertFalse($this->availability()['online']);
    }

    // ---- one truth: GET /me/presence, routing, availability ---------------------------------------------------------------

    public function test_an_auto_away_agent_is_offered_chats_in_the_second_wave_only_and_availability_follows(): void
    {
        Queue::fake();
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertSame([$this->agent->id], $this->routable([PresenceStatus::Online]));

        foreach ([60, 120, 180, 240, 300] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, false);
        }

        $this->assertSame('away', $this->statusOf($this->agent));
        $this->assertSame([], $this->routable([PresenceStatus::Online]));
        $this->assertSame([$this->agent->id], $this->routable([PresenceStatus::Away]));
        $this->assertSame([$this->billing->id => 1], app(AvailableAgents::class)->countByCategory([$this->billing->id]));

        // Away agents are reachable: the widget still says online and a chat can start; the first wave offers it to nobody.
        $this->assertTrue($this->availability()['online']);
        $response = $this->withToken($this->visitorSession($this->widget)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann'])->assertCreated();
        $chat = Conversation::query()->where('ulid', $response->json('data.ulid'))->firstOrFail();
        $this->assertSame([], ConversationOffer::query()->where('conversation_id', $chat->id)->pluck('user_id')->all());
        Queue::assertPushed(OfferNextWave::class, fn (OfferNextWave $job): bool => $job->wave === 2);

        (new OfferNextWave($chat->id, 2, now()->getTimestamp()))->handle(app(OfferToAgents::class));
        $this->assertSame([$this->agent->id], array_map('intval', ConversationOffer::query()->where('conversation_id', $chat->id)->pluck('user_id')->all()));

        // They come back to the tab: online again for routing, the roster and GET /me/presence at once.
        $this->elapse(330);
        $this->beat($this->agent, true);
        $this->assertSame([$this->agent->id], $this->routable([PresenceStatus::Online]));
    }

    public function test_availability_for_a_widget_that_only_offers_chats_to_online_agents_follows_auto_away(): void
    {
        $config = $this->widget->config;
        $config['routing']['waves'] = [['afterSeconds' => 0, 'statuses' => ['online']]];
        $this->widget->forceFill(['config' => $config])->save();
        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertTrue($this->availability()['online']);

        foreach ([60, 120, 180, 240, 300] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, false);
        }

        // The 5-minute beat made the agent away, which dropped the cached answer: no waiting for the cache to expire.
        $this->assertFalse($this->availability()['online']);

        $this->elapse(310);
        $this->beat($this->agent, true);
        $this->assertTrue($this->availability()['online']);
    }

    public function test_the_agent_who_sets_online_is_reachable_everywhere_at_once_and_going_offline_takes_them_away(): void
    {
        $this->assertFalse($this->availability()['online']);

        $this->choose($this->agent, 'online');
        $this->assertTrue($this->availability()['online']);
        $this->assertSame([$this->agent->id], $this->routable([PresenceStatus::Online, PresenceStatus::Away]));

        $this->choose($this->agent, 'offline');
        $this->assertFalse($this->availability()['online']);
        $this->assertSame([], $this->routable([PresenceStatus::Online, PresenceStatus::Away]));
    }

    public function test_the_inbox_page_and_the_roster_start_from_the_store(): void
    {
        $this->actingAs($this->agent)->get('/inbox')->assertInertia(fn ($page) => $page->where('presence.status', 'offline')->etc());

        $this->choose($this->agent, 'away');
        $this->actingAs($this->agent)->get('/inbox')->assertInertia(fn ($page) => $page->where('presence.status', 'away')->etc());
    }

    public function test_the_sweep_checks_everybody_in_batches_and_changes_each_agent_once(): void
    {
        config(['presence.sweep_batch_size' => 2]);
        $agents = [$this->agent, $this->newAgent(), $this->newAgent(), $this->newAgent(), $this->newAgent()];

        foreach ($agents as $agent) {
            $this->choose($agent, 'online', ['automatic' => true]);
        }

        Event::fake([PresenceChanged::class]);
        $this->elapse(100);

        // Two of the five dashboards are still open.
        $this->beat($agents[0], true);
        $this->beat($agents[1], true);

        $this->elapse(190);
        $this->artisan('chat:presence-sweep')->expectsOutputToContain('Checked 5 agent(s): 3 change(s) (3 offline, 0 away, 0 online)')->assertSuccessful();

        Event::assertDispatchedTimes(PresenceChanged::class, 3);
        $this->artisan('chat:presence-sweep')->expectsOutputToContain('Checked 2 agent(s): 0 change(s)')->assertSuccessful();
        Event::assertDispatchedTimes(PresenceChanged::class, 3);
    }

    // ---- the other readers: the roster and the transfer dialog -----------------------------------------------------------

    public function test_the_roster_member_info_carries_the_effective_status(): void
    {
        $this->useFortifyMode();
        $this->useReverbBroadcaster();
        $join = function (): string {
            $this->app['auth']->forgetGuards();
            $response = $this->actingAs($this->agent)->postJson('/broadcasting/auth', ['socket_id' => '1234.5678', 'channel_name' => 'presence-staff'])->assertOk();

            return (string) json_decode((string) $response->json('channel_data'), true, 512, JSON_THROW_ON_ERROR)['user_info']['status'];
        };

        $this->assertSame('offline', $join());

        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertSame('online', $join());

        foreach ([60, 120, 180, 240, 300] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, false);
        }

        $this->assertSame('away', $join());

        $this->elapse(500);
        $this->assertSame('offline', $join());
    }

    public function test_the_transfer_targets_show_what_the_transfer_accepts_from_the_store(): void
    {
        $holder = $this->newAgent();
        $chat = $this->activeChat($this->visitorSession($this->widget), $this->billing, $holder);
        $this->choose($holder, 'online');
        $targets = fn (): array => $this->actingAs($holder, 'sanctum')->getJson('/api/v1/conversations/'.$chat->ulid.'/transfer-targets')->assertOk()->json('data.agents.0');

        $this->assertSame(['status' => 'offline', 'reachable' => false], array_intersect_key($targets(), ['status' => 0, 'reachable' => 0]));
        $this->actingAs($holder, 'sanctum')->postJson('/api/v1/conversations/'.$chat->ulid.'/transfer', ['agent_id' => $this->agent->id])
            ->assertStatus(409)->assertJsonPath('error.details.reason', 'offline');

        $this->choose($this->agent, 'online', ['automatic' => true]);
        $this->assertSame(['status' => 'online', 'reachable' => true], array_intersect_key($targets(), ['status' => 0, 'reachable' => 0]));

        foreach ([60, 120, 180, 240, 300] as $second) {
            $this->elapse($second);
            $this->beat($this->agent, false);
            $this->beat($holder, true);
        }

        $this->assertSame(['status' => 'away', 'reachable' => true], array_intersect_key($targets(), ['status' => 0, 'reachable' => 0]));
    }
}
