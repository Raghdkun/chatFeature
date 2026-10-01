<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Actions\OfferToAgents;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Jobs\ExpireQueuedConversation;
use App\Domain\Chat\Jobs\OfferNextWave;
use App\Domain\Chat\Services\RoutingPlan;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * Routing waves (decision P4-D4): who is offered a new chat and when, with the clock under the test's control.
 */
class OfferRoutingTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
    }

    private function start(): Conversation
    {
        $response = $this->withToken($this->visitorSession($this->widget)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann'])->assertCreated();

        return Conversation::query()->where('ulid', $response->json('data.ulid'))->firstOrFail();
    }

    /**
     * @param  list<array{afterSeconds: int, statuses: list<string>}>  $waves
     */
    private function useWaves(array $waves): void
    {
        $config = $this->widget->config;
        $config['routing']['waves'] = $waves;
        $this->widget->forceFill(['config' => $config])->save();
    }

    private function runWave(Conversation $chat, int $wave): void
    {
        (new OfferNextWave($chat->id, $wave, now()->getTimestamp()))->handle(app(OfferToAgents::class));
    }

    /**
     * @return list<int>
     */
    private function offered(Conversation $chat): array
    {
        return array_map('intval', ConversationOffer::query()->where('conversation_id', $chat->id)->orderBy('user_id')->pluck('user_id')->all());
    }

    public function test_online_agents_are_offered_at_once_and_away_agents_by_the_second_wave(): void
    {
        Queue::fake();
        $online = $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);

        $chat = $this->start();

        $this->assertSame([$online->id], $this->offered($chat));
        Queue::assertPushed(OfferNextWave::class, fn (OfferNextWave $job): bool => $job->wave === 2 && $job->conversationId === $chat->id && $job->delay === 20);
        Queue::assertPushed(ExpireQueuedConversation::class, fn (ExpireQueuedConversation $job): bool => $job->conversationId === $chat->id && $job->delay >= 91 && $job->delay <= 93);
        Queue::assertPushed(OfferNextWave::class, 1);

        Event::fake([ChatOffered::class]);
        $this->travel(20)->seconds();
        $this->runWave($chat, 2);

        $this->assertEqualsCanonicalizing([$online->id, $away->id], $this->offered($chat));
        $this->assertSame(2, ConversationOffer::query()->where('user_id', $away->id)->sole()->wave);
        $this->assertSame(2, $chat->fresh()->wave);
        Event::assertDispatched(ChatOffered::class, fn (ChatOffered $event): bool => $event->wave === 2 && $event->offers->pluck('user_id')->all() === [$away->id]);
        $this->assertSame('offered', $chat->events()->reorder('id', 'desc')->first()->type);
    }

    public function test_an_agent_who_came_online_after_wave_one_is_offered_the_chat_by_wave_two(): void
    {
        Queue::fake();
        $first = $this->availableAgent($this->billing);
        $chat = $this->start();
        $late = $this->availableAgent($this->billing);

        $this->travel(20)->seconds();
        $this->setPresence($first, PresenceStatus::Online);
        $this->setPresence($late, PresenceStatus::Online);
        $this->runWave($chat, 2);

        $this->assertEqualsCanonicalizing([$first->id, $late->id], $this->offered($chat));
        $this->assertSame(1, ConversationOffer::query()->where('user_id', $first->id)->count(), 'nobody is offered the chat twice');
    }

    public function test_a_wave_that_runs_early_or_twice_does_nothing_new(): void
    {
        Queue::fake();
        $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();

        // A sync queue runs delayed jobs at once: the due time keeps wave 2 from firing early.
        (new OfferNextWave($chat->id, 2, now()->addSeconds(20)->getTimestamp()))->handle(app(OfferToAgents::class));
        $this->assertNotContains($away->id, $this->offered($chat));

        $this->travel(20)->seconds();
        $this->runWave($chat, 2);
        Event::fake([ChatOffered::class]);
        $this->runWave($chat, 2);
        $this->assertCount(2, $this->offered($chat));
        Event::assertNotDispatched(ChatOffered::class);
    }

    public function test_a_wave_for_a_chat_that_is_no_longer_waiting_does_nothing(): void
    {
        Queue::fake();
        $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);

        foreach (['active', 'closed', 'missed'] as $status) {
            $chat = $this->start();
            Conversation::query()->whereKey($chat->id)->update(['status' => $status]);
            $this->travel(20)->seconds();
            $this->runWave($chat, 2);

            $this->assertNotContains($away->id, $this->offered($chat), $status);
            $this->travelBack();
        }
    }

    public function test_a_wave_after_the_queue_deadline_does_nothing(): void
    {
        Queue::fake();
        $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();

        $this->travel(95)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        $this->runWave($chat, 2);

        $this->assertNotContains($away->id, $this->offered($chat));
    }

    public function test_offers_expire_with_the_queue_deadline_and_belong_to_agents_who_can_take_the_chat(): void
    {
        $inTopic = $this->availableAgent($this->billing);
        $other = User::factory()->agent()->create();
        $this->setPresence($other, PresenceStatus::Online);
        $busy = $this->availableAgent($this->billing, ['max_concurrent_chats' => 1]);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $busy);
        $offline = $this->availableAgent($this->billing, status: PresenceStatus::Offline);

        $chat = $this->start();

        $this->assertSame([$inTopic->id], $this->offered($chat));
        $offer = ConversationOffer::query()->sole();
        $this->assertTrue($offer->expires_at->equalTo($chat->queue_expires_at));
        $this->assertSame(1, $offer->wave);
        $this->assertNull($offer->responded_at);
        $this->assertNotSame($offline->id, $offer->user_id);
    }

    public function test_the_widgets_own_waves_drive_the_routing(): void
    {
        Queue::fake();
        $this->useWaves([
            ['afterSeconds' => 0, 'statuses' => ['online']],
            ['afterSeconds' => 10, 'statuses' => ['away']],
            ['afterSeconds' => 30, 'statuses' => ['online', 'away']],
        ]);
        $online = $this->availableAgent($this->billing);
        $this->availableAgent($this->billing, status: PresenceStatus::Away);

        $chat = $this->start();

        $this->assertSame([$online->id], $this->offered($chat));
        Queue::assertPushed(OfferNextWave::class, 2);
        Queue::assertPushed(OfferNextWave::class, fn (OfferNextWave $job): bool => $job->wave === 2 && $job->delay === 10);
        Queue::assertPushed(OfferNextWave::class, fn (OfferNextWave $job): bool => $job->wave === 3 && $job->delay === 30);
    }

    public function test_a_first_wave_with_a_delay_offers_nothing_until_it_is_due(): void
    {
        Queue::fake();
        $this->useWaves([['afterSeconds' => 5, 'statuses' => ['online']]]);
        $online = $this->availableAgent($this->billing);

        $chat = $this->start();

        $this->assertSame([], $this->offered($chat));
        Queue::assertPushed(OfferNextWave::class, fn (OfferNextWave $job): bool => $job->wave === 1 && $job->delay === 5);

        $this->travel(5)->seconds();
        $this->setPresence($online, PresenceStatus::Online);
        $this->runWave($chat, 1);
        $this->assertSame([$online->id], $this->offered($chat));
    }

    public function test_a_plan_with_only_away_agents_in_it_ignores_offline_ones(): void
    {
        $this->useWaves([['afterSeconds' => 0, 'statuses' => ['online']]]);
        $this->availableAgent($this->billing, status: PresenceStatus::Away);

        // Away agents are not in the plan: nobody can take the chat.
        $this->withToken($this->visitorSession($this->widget)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann'])
            ->assertStatus(409)->assertJsonPath('error.code', 'no_agents');
    }

    public function test_the_default_plan_follows_the_wave_delay_setting(): void
    {
        $this->assertSame(20, RoutingPlan::default()->delayFor(2));

        settings()->set('chat.offer_wave_delay_seconds', 45);
        $this->assertSame(45, RoutingPlan::default()->delayFor(2));

        settings()->set('chat.offer_wave_delay_seconds', 0);
        $this->assertSame(0, RoutingPlan::default()->delayFor(2));
    }

    public function test_the_queue_timeout_comes_from_the_widget(): void
    {
        $this->widget->forceFill(['queue_timeout_seconds' => 30])->save();
        $this->availableAgent($this->billing);

        $chat = $this->start();

        $this->assertEqualsWithDelta(now()->addSeconds(30)->getTimestamp(), $chat->queue_expires_at->getTimestamp(), 2);
        $this->assertSame(ConversationStatus::Queued, $chat->status);
    }

    // ---- the wave sweep (C1) and queue epochs (C3) ------------------------------------------------------------------------

    public function test_without_a_queue_worker_the_sweep_makes_the_later_waves_when_they_are_due(): void
    {
        // QUEUE_CONNECTION=sync (the phpunit default): the delayed job runs at once, finds the wave not due and drops out.
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);

        $chat = $this->start();

        $this->assertSame([], $this->offered($chat), 'wave 1 (online agents) has nobody');
        $this->assertSame(1, $chat->fresh()->wave);

        $this->artisan('chat:offer-waves')->expectsOutputToContain('Advanced the routing of 0 queued chat(s).')->assertSuccessful();
        $this->assertSame([], $this->offered($chat), 'not due yet');

        $this->travel(21)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        Event::fake([ChatOffered::class]);
        $this->artisan('chat:offer-waves')->expectsOutputToContain('Advanced the routing of 1 queued chat(s).')->assertSuccessful();

        $this->assertSame([$away->id], $this->offered($chat));
        $this->assertSame(2, $chat->fresh()->wave);
        Event::assertDispatched(ChatOffered::class, fn (ChatOffered $event): bool => $event->wave === 2);

        // Idempotent: the next minute finds nothing to do.
        $this->artisan('chat:offer-waves')->expectsOutputToContain('Advanced the routing of 0 queued chat(s).')->assertSuccessful();
        $this->assertSame([$away->id], $this->offered($chat));
    }

    public function test_the_sweep_catches_a_job_that_was_lost_on_a_real_queue(): void
    {
        Queue::fake();
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();
        Queue::assertPushed(OfferNextWave::class, 1);

        // The job never ran (a failed job, a flushed queue): a minute later the sweep does its work.
        $this->travel(60)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        $this->artisan('chat:offer-waves')->assertSuccessful();

        $this->assertSame([$away->id], $this->offered($chat));
    }

    public function test_the_sweep_runs_the_latest_due_wave_and_skips_chats_that_are_over_or_out_of_time(): void
    {
        Queue::fake();
        $this->useWaves([
            ['afterSeconds' => 0, 'statuses' => ['online']],
            ['afterSeconds' => 10, 'statuses' => ['away']],
            ['afterSeconds' => 30, 'statuses' => ['online', 'away']],
        ]);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();
        $claimed = $this->start();
        Conversation::query()->whereKey($claimed->id)->update(['status' => 'active']);
        $expired = $this->start();
        Conversation::query()->whereKey($expired->id)->update(['queue_expires_at' => now()->addSeconds(5)]);

        $this->travel(40)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        $this->artisan('chat:offer-waves')->assertSuccessful();

        $this->assertSame([$away->id], $this->offered($chat));
        $this->assertSame(3, $chat->fresh()->wave, 'waves are cumulative: the last due one is the one that runs');
        $this->assertSame([], $this->offered($claimed));
        $this->assertSame([], $this->offered($expired));
    }

    public function test_a_wave_job_from_an_earlier_trip_through_the_queue_is_ignored(): void
    {
        Queue::fake();
        $first = $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();
        $this->assertSame(0, (int) $chat->fresh()->claim_version);

        // The first agent takes the chat and hands it back to the category a few seconds later.
        $this->travel(5)->seconds();
        $this->actingAs($first, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/claim")->assertOk();
        $this->actingAs($first, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/transfer", ['category' => 'billing'])->assertOk();
        $this->assertSame(1, (int) $chat->fresh()->claim_version);

        // The wave-2 job of the FIRST trip (epoch 0) fires: the new trip's wave 2 is not due, so it must not offer anything.
        $this->travel(15)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        $before = $this->offered($chat);
        (new OfferNextWave($chat->id, 2, now()->getTimestamp(), 0))->handle(app(OfferToAgents::class));
        $this->assertSame($before, $this->offered($chat));
        $this->assertNotContains($away->id, $this->offered($chat));

        // The job of the current trip (epoch 1) is honoured once it is due.
        $this->travel(10)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        (new OfferNextWave($chat->id, 2, now()->getTimestamp(), 1))->handle(app(OfferToAgents::class));
        $this->assertContains($away->id, $this->offered($chat));
    }

    public function test_a_chat_handed_to_one_colleague_is_never_widened_by_a_wave(): void
    {
        Queue::fake();
        $first = $this->availableAgent($this->billing);
        $colleague = $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $chat = $this->start();

        $this->actingAs($first, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/claim")->assertOk();
        $this->actingAs($first, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/transfer", ['agent_id' => $colleague->id])->assertOk();
        $this->assertSame([$first->id, $colleague->id], $this->offered($chat));

        // Neither a stale job nor the sweep may offer the chat to the away agent.
        $this->travel(60)->seconds();
        $this->setPresence($away, PresenceStatus::Away);
        $this->setPresence($colleague, PresenceStatus::Online);
        (new OfferNextWave($chat->id, 2, now()->getTimestamp(), 0))->handle(app(OfferToAgents::class));
        $this->artisan('chat:offer-waves')->assertSuccessful();

        $this->assertNotContains($away->id, $this->offered($chat));
        $offers = ConversationOffer::query()->where('conversation_id', $chat->id)->orderBy('user_id')->get();
        $this->assertSame('dismissed', $offers->firstWhere('user_id', $first->id)->response->value);
        $this->assertNull($offers->firstWhere('user_id', $colleague->id)->responded_at);
    }

    public function test_the_wave_job_is_retried_a_few_times(): void
    {
        $job = new OfferNextWave(1, 2, 0);

        $this->assertSame(3, $job->tries);
        $this->assertSame([3, 10], $job->backoff());
    }
}
