<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Rating;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * The rating prompt: its time window is enforced on rate and skip (C9), and a widget with the rating feature off never asks (B4).
 */
class RatingLifecycleApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->billing);
    }

    private function ratingFeature(bool $on): void
    {
        $config = $this->widget->config;
        $config['features']['rating'] = $on;
        $this->widget->forceFill(['config' => $config])->save();
    }

    public function test_a_rating_after_the_window_is_refused_even_before_the_sweep_closed_the_chat(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = Conversation::factory()->ended($this->agent)->forCategory($this->billing)->create([
            'widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id,
        ]);

        // Inside the window it works; three days later (the sweep did not run) it does not.
        $this->travel(11)->minutes();

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 5])
            ->assertStatus(409)->assertJsonPath('error.code', 'rating_window_closed');
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating/skip")
            ->assertStatus(409)->assertJsonPath('error.code', 'rating_window_closed');

        $chat->refresh();
        $this->assertSame(ConversationStatus::Ended, $chat->status);
        $this->assertSame(0, Rating::query()->count());

        // The sweep still closes it as `timeout`.
        $this->artisan('chat:close-unrated')->assertSuccessful();
        $this->assertSame(ConversationCloseReason::Timeout, $chat->fresh()->close_reason);
    }

    public function test_a_rating_inside_the_window_still_works(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = Conversation::factory()->ended($this->agent)->forCategory($this->billing)->create([
            'widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id,
        ]);

        $this->travel(9)->minutes();

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 4])->assertCreated();
        $this->assertSame(ConversationStatus::Closed, $chat->fresh()->status);
    }

    public function test_the_window_is_not_a_reason_for_another_code_once_the_chat_is_not_ended(): void
    {
        $token = $this->visitorSession($this->widget);
        $active = $this->activeChat($token, $this->billing, $this->agent);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$active->ulid}/rating", ['score' => 5])->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_ended');
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$active->ulid}/rating/skip")->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_ended');
    }

    public function test_skipping_is_accepted_for_an_ended_chat_whatever_the_widget_says_about_rating(): void
    {
        $this->ratingFeature(false);
        $token = $this->visitorSession($this->widget);
        $chat = Conversation::factory()->ended($this->agent)->forCategory($this->billing)->create([
            'widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id,
        ]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating/skip")
            ->assertOk()->assertJsonPath('data.status', 'closed')->assertJsonPath('data.ratingRequested', false);
        $this->assertSame(ConversationCloseReason::Skipped, $chat->fresh()->close_reason);
    }

    public function test_ending_a_chat_on_a_widget_without_rating_closes_it_at_once(): void
    {
        $this->ratingFeature(false);
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->agent);
        Event::fake([ConversationEnded::class, ConversationClosed::class]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/end")
            ->assertOk()
            ->assertJsonPath('data.status', 'closed')
            ->assertJsonPath('data.ratingRequested', false);

        $chat->refresh();
        $this->assertSame(ConversationStatus::Closed, $chat->status);
        $this->assertSame(ConversationCloseReason::Skipped, $chat->close_reason);
        $this->assertSame(ConversationEndedBy::Visitor, $chat->ended_by);
        $this->assertNotNull($chat->ended_at);
        $this->assertNotNull($chat->closed_at);
        $this->assertFalse($chat->rating_requested);
        $this->assertNull($chat->rating_window_expires_at);
        $this->assertNull($chat->idle_expires_at);
        $this->assertSame(['ended', 'closed'], $chat->events()->whereIn('type', ['ended', 'closed'])->orderBy('id')->pluck('type')->all());
        Event::assertDispatched(ConversationEnded::class, fn (ConversationEnded $event): bool => $event->endedBy === ConversationEndedBy::Visitor);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::Skipped);

        // The agent's side ends it the same way.
        $other = $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->agent);
        $this->actingAs($this->agent, 'sanctum')->postJson("/api/v1/conversations/{$other->ulid}/end")->assertOk()->assertJsonPath('data.status', 'closed');
        $this->assertSame(ConversationEndedBy::Agent, $other->fresh()->ended_by);

        // Nothing is left for the unrated sweep.
        $this->travel(60)->minutes();
        $this->artisan('chat:close-unrated')->expectsOutputToContain('0')->assertSuccessful();
    }

    public function test_ending_a_chat_on_a_widget_with_rating_still_asks_for_a_rating(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->agent);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/end")
            ->assertOk()->assertJsonPath('data.status', 'ended')->assertJsonPath('data.ratingRequested', true);
    }
}
