<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationRated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * The visitor's chat lifecycle over the public API: start (pre-chat rules, topic, availability, one open chat per session),
 * the current conversation, end, cancel, rating, and the IDOR matrix (another visitor's conversation is 404, never 403).
 */
class PublicConversationApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function start(IssuedVisitorToken $token, array $payload = []): TestResponse
    {
        return $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', $payload + ['category' => 'billing', 'name' => 'Ann']);
    }

    public function test_a_visitor_starts_a_chat_that_is_queued_and_offered_to_the_available_agents(): void
    {
        $agent = $this->availableAgent($this->billing);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $token = $this->visitorSession($this->widget, ['name' => null, 'email' => null]);

        $response = $this->start($token, ['name' => ' Ann ', 'email' => 'ann@example.test', 'message' => "Hello\r\nI need help"])
            ->assertCreated()
            ->assertJsonPath('data.status', 'queued')
            ->assertJsonPath('data.type', 'live')
            ->assertJsonPath('data.category', ['slug' => 'billing', 'label' => 'Billing'])
            ->assertJsonPath('data.agent', null)
            ->assertJsonPath('data.ratingRequested', false)
            ->assertJsonPath('data.lastSeq', 1)
            ->assertJsonPath('data.endedAt', null)
            ->assertJsonStructure(['data' => ['ulid', 'ticketNo', 'createdAt']]);

        $this->assertMatchesRegularExpression('/^[A-HJKMNP-Z2-9]{6}$/', $response->json('data.ticketNo'));
        $this->assertStringNotContainsString('"id"', (string) $response->getContent());

        $conversation = Conversation::query()->where('ulid', $response->json('data.ulid'))->firstOrFail();
        $this->assertSame($token->session->id, $conversation->visitor_session_id);
        $this->assertSame($this->billing->id, $conversation->category_id);
        $this->assertTrue($conversation->queue_expires_at->between(now()->addSeconds(85), now()->addSeconds(95)));
        $this->assertSame('Ann', $token->session->visitor->fresh()->name);
        $this->assertSame('ann@example.test', $token->session->visitor->fresh()->email);

        $message = Message::query()->where('conversation_id', $conversation->id)->sole();
        $this->assertSame(1, $message->seq);
        $this->assertSame("Hello\nI need help", $message->body);
        $this->assertSame(1, $conversation->unseen_by_agent);
        $this->assertSame('Hello I need help', $conversation->last_message_preview);

        // Wave 1 reaches the online agent only; the away agent is offered the chat by the later wave.
        $this->assertSame([$agent->id], ConversationOffer::query()->where('conversation_id', $conversation->id)->pluck('user_id')->all());
        $this->assertDatabaseMissing('conversation_agent_alerts', ['user_id' => $away->id]);
        $this->assertSame(1, ConversationOffer::query()->sole()->wave);
        $this->assertSame(1, $conversation->fresh()->wave);

        $created = $conversation->events()->where('type', 'created')->sole();
        $this->assertSame('visitor', $created->actor_type->value);
        $this->assertSame('billing', $created->payload['category']);
    }

    public function test_starting_a_chat_dispatches_the_domain_events(): void
    {
        Event::fake([ConversationQueued::class, QueueChanged::class, ChatOffered::class]);
        $agent = $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);

        $this->start($token)->assertCreated();

        Event::assertDispatched(ConversationQueued::class);
        Event::assertDispatched(QueueChanged::class);
        Event::assertDispatched(ChatOffered::class, fn (ChatOffered $event): bool => $event->wave === 1
            && $event->offers->pluck('user_id')->all() === [$agent->id]
            && $event->expiresAt->equalTo($event->conversation->queue_expires_at));
    }

    public function test_the_prechat_rules_of_the_widget_are_enforced_on_the_server(): void
    {
        $this->availableAgent($this->billing);
        $config = $this->widget->config;
        $config['preChat'] = ['fields' => ['name' => ['enabled' => true, 'required' => true], 'email' => ['enabled' => true, 'required' => true], 'phone' => ['enabled' => false, 'required' => false]], 'consentText' => 'I agree to be recorded.'];
        $this->widget->forceFill(['config' => $config])->save();
        $token = $this->visitorSession($this->widget, ['name' => null, 'email' => null]);

        $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['name', 'email', 'consent']]]);

        $this->start($token, ['name' => 'Ann', 'email' => 'bad', 'consent' => true])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['email']]]);
        $this->start($token, ['name' => 'Ann', 'email' => 'ann@example.test', 'consent' => false])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['consent']]]);

        $this->start($token, ['name' => 'Ann', 'email' => 'ann@example.test', 'consent' => true, 'phone' => '+1 555 0100'])->assertCreated();

        // A disabled field is ignored, not stored; the consent that was given is on record.
        $this->assertNull($token->session->visitor->fresh()->phone);
        $this->assertTrue(Conversation::query()->latest('id')->firstOrFail()->events()->where('type', 'created')->sole()->payload['consent']);
        $this->assertSame(0, Conversation::query()->where('status', 'closed')->count());
    }

    public function test_what_a_visitor_already_gave_satisfies_a_required_field(): void
    {
        $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget, ['name' => 'Ann Verified', 'verified' => true, 'external_id' => 'u-1']);

        $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Spoof'])->assertCreated();

        // A verified identity keeps what it vouched for.
        $this->assertSame('Ann Verified', $token->session->visitor->fresh()->name);
    }

    public function test_nothing_is_asked_when_the_prechat_feature_is_off(): void
    {
        $this->availableAgent($this->billing);
        $config = $this->widget->config;
        $config['features']['preChat'] = false;
        $config['preChat']['consentText'] = 'Consent needed';
        $this->widget->forceFill(['config' => $config])->save();
        $token = $this->visitorSession($this->widget, ['name' => null]);

        $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ignored'])->assertCreated();

        $this->assertNull($token->session->visitor->fresh()->name);
    }

    public function test_the_category_must_be_active_and_enabled_on_the_widget(): void
    {
        $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);
        $inactive = Category::factory()->inactive()->create(['slug' => 'old']);
        $this->widget->categories()->attach($inactive->id, ['sort_order' => 1]);
        Category::factory()->create(['slug' => 'elsewhere']);

        foreach (['unknown', 'old', 'elsewhere'] as $slug) {
            $this->start($token, ['category' => $slug])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['category']]]);
        }

        $this->start($token, ['category' => ''])->assertStatus(422);
        $this->assertSame(0, Conversation::query()->count());
    }

    public function test_no_agents_answers_409_so_the_client_offers_the_offline_form(): void
    {
        $token = $this->visitorSession($this->widget);

        // Nobody has presence.
        $this->start($token)->assertStatus(409)->assertJsonPath('error.code', 'no_agents');

        // Present agents who cannot take it: offline, stale heartbeat, another topic, at capacity.
        $offline = $this->availableAgent($this->billing, status: PresenceStatus::Offline);
        $stale = $this->availableAgent($this->billing);
        $this->setPresence($stale, PresenceStatus::Online, heartbeatSecondsAgo: 91);
        $other = User::factory()->agent()->create();
        $this->setPresence($other, PresenceStatus::Online);
        $busy = $this->availableAgent($this->billing, ['max_concurrent_chats' => 1]);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $busy);
        $inactive = $this->availableAgent($this->billing);
        $inactive->forceFill(['is_active' => false])->save();

        $this->start($token)->assertStatus(409)->assertJsonPath('error.code', 'no_agents');
        $this->assertSame(0, Conversation::query()->where('visitor_session_id', $token->session->id)->count());

        // One reachable agent is enough.
        $this->availableAgent($this->billing);
        $this->start($token)->assertCreated();
    }

    public function test_an_away_agent_counts_and_a_closed_widget_does_not(): void
    {
        $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $token = $this->visitorSession($this->widget);

        $this->start($token)->assertCreated();

        [$closed, $category] = $this->chatWidget(['offline_mode' => 'always_offline'], 'sales');
        $this->availableAgent($category);
        $this->withToken($this->visitorSession($closed)->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'sales', 'name' => 'Ann'])->assertStatus(409)->assertJsonPath('error.code', 'no_agents');
    }

    public function test_a_session_has_one_open_live_chat(): void
    {
        $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);

        $first = $this->start($token)->assertCreated();
        $this->start($token)->assertStatus(409)->assertJsonPath('error.code', 'conversation_exists');

        // Another session of another visitor is independent.
        $this->start($this->visitorSession($this->widget))->assertCreated();

        // A finished chat no longer blocks (an `ended` one only waits for its rating).
        Conversation::query()->where('ulid', $first->json('data.ulid'))->update(['status' => 'ended']);
        $this->start($token)->assertCreated();
        $this->assertSame(2, Conversation::query()->where('visitor_session_id', $token->session->id)->count());
    }

    public function test_the_current_conversation_is_this_sessions_latest_live_chat_only(): void
    {
        $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);
        $other = $this->visitorSession($this->widget);

        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertOk()->assertExactJson(['data' => null]);

        $ulid = $this->start($token)->json('data.ulid');

        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertOk()->assertJsonPath('data.ulid', $ulid)->assertJsonPath('data.status', 'queued');
        // Visitors never see anybody else's chats or history.
        $this->withToken($other->plaintext)->getJson('/api/v1/public/conversation')->assertOk()->assertExactJson(['data' => null]);

        // A missed chat stays readable so the panel can offer the offline form; offline tickets are not "the conversation".
        Conversation::query()->where('ulid', $ulid)->update(['status' => 'missed']);
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'missed');
        Conversation::factory()->offline()->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.ulid', $ulid);
    }

    public function test_the_visitor_ends_an_active_chat_and_is_asked_to_rate(): void
    {
        Event::fake([ConversationEnded::class]);
        $agent = User::factory()->agent()->create();
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $agent);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/end")
            ->assertOk()
            ->assertJsonPath('data.status', 'ended')
            ->assertJsonPath('data.ratingRequested', true)
            ->assertJsonPath('data.agent.name', $agent->label);

        $chat->refresh();
        $this->assertSame(ConversationEndedBy::Visitor, $chat->ended_by);
        $this->assertNotNull($chat->ended_at);
        $this->assertTrue($chat->rating_window_expires_at->between(now()->addMinutes(9), now()->addMinutes(11)));
        $this->assertNull($chat->idle_expires_at);
        $this->assertSame('visitor', $chat->events()->where('type', 'ended')->sole()->actor_type->value);
        Event::assertDispatched(ConversationEnded::class, fn (ConversationEnded $event): bool => $event->endedBy === ConversationEndedBy::Visitor);

        // Ending twice is a conflict, not a second ending.
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/end")->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
    }

    public function test_a_queued_chat_is_cancelled_not_ended_and_the_widget_can_forbid_ending(): void
    {
        $agent = $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);
        $queued = $this->queuedChat($token, $this->billing, [$agent]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$queued->ulid}/end")->assertStatus(409);

        $config = $this->widget->config;
        $config['features']['endChatByVisitor'] = false;
        $this->widget->forceFill(['config' => $config])->save();
        $other = $this->visitorSession($this->widget);
        $active = $this->activeChat($other, $this->billing, $agent);
        $this->withToken($other->plaintext)->postJson("/api/v1/public/conversations/{$active->ulid}/end")->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');
        $this->assertSame(ConversationStatus::Active, $active->fresh()->status);
    }

    public function test_the_visitor_cancels_a_queued_chat(): void
    {
        Event::fake([ConversationClosed::class, QueueChanged::class]);
        $agent = $this->availableAgent($this->billing);
        $token = $this->visitorSession($this->widget);
        $chat = $this->queuedChat($token, $this->billing, [$agent]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/cancel")
            ->assertOk()
            ->assertJsonPath('data.status', 'closed');

        $chat->refresh();
        $this->assertSame(ConversationCloseReason::Cancelled, $chat->close_reason);
        $this->assertNotNull($chat->closed_at);
        $this->assertSame(OfferResponse::Expired, ConversationOffer::query()->sole()->response);
        $this->assertSame('cancelled', $chat->events()->latest('id')->first()->type);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::Cancelled);
        Event::assertDispatched(QueueChanged::class);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/cancel")->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_queued');
    }

    public function test_an_accepted_chat_cannot_be_cancelled(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, User::factory()->create());

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/cancel")->assertStatus(409);
        $this->assertSame(ConversationStatus::Active, $chat->fresh()->status);
    }

    public function test_the_visitor_rates_the_chat_that_ended(): void
    {
        Event::fake([ConversationRated::class, ConversationClosed::class]);
        $token = $this->visitorSession($this->widget);
        $chat = Conversation::factory()->ended()->forCategory($this->billing)->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 6])->assertStatus(422);
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 0])->assertStatus(422);
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 4, 'comment' => str_repeat('x', 2001)])->assertStatus(422);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 4, 'comment' => "  Great\x00 help  "])
            ->assertCreated()
            ->assertJsonPath('data.conversation', $chat->ulid)
            ->assertJsonPath('data.score', 4)
            ->assertJsonPath('data.comment', 'Great help');

        $chat->refresh();
        $this->assertSame(ConversationStatus::Closed, $chat->status);
        $this->assertSame(ConversationCloseReason::Rated, $chat->close_reason);
        $this->assertFalse($chat->rating_requested);
        $this->assertSame(4, Rating::query()->sole()->score);
        Event::assertDispatched(ConversationRated::class, fn (ConversationRated $event): bool => $event->rating->score === 4);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::Rated);

        // One rating per conversation.
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 5])->assertStatus(409)->assertJsonPath('error.code', 'already_rated');
        $this->assertSame(1, Rating::query()->count());
    }

    public function test_only_an_ended_chat_can_be_rated_or_skipped(): void
    {
        $token = $this->visitorSession($this->widget);
        $active = $this->activeChat($token, $this->billing, User::factory()->create());

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$active->ulid}/rating", ['score' => 5])->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_ended');
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$active->ulid}/rating/skip")->assertStatus(409);
        $this->assertSame(0, Rating::query()->count());
    }

    public function test_the_visitor_may_skip_the_rating(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = Conversation::factory()->ended()->forCategory($this->billing)->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating/skip")->assertOk()->assertJsonPath('data.status', 'closed')->assertJsonPath('data.ratingRequested', false);

        $this->assertSame(ConversationCloseReason::Skipped, $chat->fresh()->close_reason);
        $this->assertSame(0, Rating::query()->count());
    }

    public function test_another_visitors_conversation_is_not_found_on_every_call(): void
    {
        $agent = User::factory()->agent()->create();
        $owner = $this->visitorSession($this->widget);
        $stranger = $this->visitorSession($this->widget);
        $chat = $this->activeChat($owner, $this->billing, $agent);
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing);
        $ended = Conversation::factory()->ended()->create(['widget_id' => $this->widget->id, 'visitor_id' => $owner->session->visitor_id, 'visitor_session_id' => $owner->session->id]);

        $calls = [
            ['getJson', "/api/v1/public/conversations/{$chat->ulid}/messages", []],
            ['postJson', "/api/v1/public/conversations/{$chat->ulid}/messages", ['body' => 'hi']],
            ['postJson', "/api/v1/public/conversations/{$chat->ulid}/attachments", ['file' => $this->pngUpload()]],
            ['postJson', "/api/v1/public/conversations/{$chat->ulid}/receipts", ['seen_upto' => 1]],
            ['postJson', "/api/v1/public/conversations/{$chat->ulid}/typing", ['typing' => true]],
            ['postJson', "/api/v1/public/conversations/{$chat->ulid}/end", []],
            ['postJson', "/api/v1/public/conversations/{$queued->ulid}/cancel", []],
            ['postJson', "/api/v1/public/conversations/{$ended->ulid}/rating", ['score' => 5]],
            ['postJson', "/api/v1/public/conversations/{$ended->ulid}/rating/skip", []],
        ];

        foreach ($calls as [$method, $url, $body]) {
            $this->withToken($stranger->plaintext)->{$method}($url, $body)->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }

        $this->assertSame(ConversationStatus::Active, $chat->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $queued->fresh()->status);
        $this->assertSame(ConversationStatus::Ended, $ended->fresh()->status);
        $this->assertSame(0, Rating::query()->count());
        $this->assertSame(0, Message::query()->count());

        // An unknown ulid and a malformed one are the same 404.
        $this->withToken($owner->plaintext)->getJson('/api/v1/public/conversations/01JABCDEFGHJKMNPQRSTVWXYZ0/messages')->assertNotFound();
        $this->withToken($owner->plaintext)->getJson('/api/v1/public/conversations/not-a-ulid/messages')->assertNotFound();
    }

    public function test_a_visitor_cannot_use_another_widgets_session_or_a_visitor_of_the_same_widget_through_session_reuse(): void
    {
        $agent = User::factory()->agent()->create();
        $owner = $this->visitorSession($this->widget);
        $chat = $this->activeChat($owner, $this->billing, $agent);

        // Same visitor row, a second session: the conversation belongs to the session that created it.
        $sibling = app(VisitorTokenService::class)->issue($owner->session->visitor);

        $this->withToken($sibling->plaintext)->getJson("/api/v1/public/conversations/{$chat->ulid}/messages")->assertNotFound();
    }
}
