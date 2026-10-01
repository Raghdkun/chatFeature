<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\ChatOffered;
use App\Domain\Chat\Events\ConversationAssigned;
use App\Domain\Chat\Events\ConversationClosed;
use App\Domain\Chat\Events\ConversationEnded;
use App\Domain\Chat\Events\ConversationQueued;
use App\Domain\Chat\Events\ConversationTransferred;
use App\Domain\Chat\Events\QueueChanged;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `POST /conversations/{ulid}/end`, `.../close` and `.../transfer`: who may do them, the state each needs, and what they leave behind.
 */
class StaffLifecycleApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private Category $sales;

    private User $agent;

    private User $colleague;

    private User $salesAgent;

    private User $admin;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->sales = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $this->widget->categories()->attach($this->sales->id, ['sort_order' => 1]);
        $this->agent = $this->availableAgent($this->billing, ['name' => 'Sara Agent']);
        $this->colleague = $this->availableAgent($this->billing, ['name' => 'Colin Colleague']);
        $this->salesAgent = $this->availableAgent($this->sales, ['name' => 'Sam Sales']);
        $this->admin = User::factory()->admin()->create(['name' => 'Ada Admin']);
        $this->chat = $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->agent);
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function act(User $user, string $action, array $body = [], ?Conversation $chat = null): TestResponse
    {
        return $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.($chat ?? $this->chat)->ulid.'/'.$action, $body);
    }

    public function test_the_agent_ends_their_chat_and_the_visitor_is_asked_to_rate(): void
    {
        Event::fake([ConversationEnded::class]);

        $this->act($this->agent, 'end')->assertOk()->assertJsonPath('data.status', 'ended')->assertJsonPath('data.ratingRequested', true)->assertJsonPath('data.assignedAgent.id', $this->agent->id);

        $this->chat->refresh();
        $this->assertSame(ConversationEndedBy::Agent, $this->chat->ended_by);
        $this->assertTrue($this->chat->rating_window_expires_at->between(now()->addMinutes(9), now()->addMinutes(11)));
        $this->assertSame('agent', $this->chat->events()->where('type', 'ended')->sole()->actor_type->value);
        Event::assertDispatched(ConversationEnded::class, fn (ConversationEnded $event): bool => $event->endedBy === ConversationEndedBy::Agent);

        $this->act($this->agent, 'end')->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
    }

    public function test_the_rating_window_follows_the_setting(): void
    {
        settings()->set('chat.rating_window_minutes', 3);

        $this->act($this->agent, 'end')->assertOk();

        $this->assertEqualsWithDelta(now()->addMinutes(3)->getTimestamp(), $this->chat->fresh()->rating_window_expires_at->getTimestamp(), 2);
    }

    public function test_an_admin_ends_any_chat_as_admin_and_others_may_not(): void
    {
        $this->act($this->colleague, 'end')->assertForbidden();
        $this->act($this->salesAgent, 'end')->assertForbidden();
        $this->assertSame(ConversationStatus::Active, $this->chat->fresh()->status);

        $this->act($this->admin, 'end')->assertOk();
        $this->assertSame(ConversationEndedBy::Admin, $this->chat->fresh()->ended_by);
    }

    public function test_only_an_active_live_chat_can_be_ended(): void
    {
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing);
        $ticket = Conversation::factory()->offline()->active($this->agent)->create(['widget_id' => $this->widget->id]);
        $closed = Conversation::factory()->closed($this->agent)->create(['widget_id' => $this->widget->id]);

        $this->act($this->admin, 'end', chat: $queued)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        $this->act($this->agent, 'end', chat: $ticket)->assertStatus(409);
        $this->act($this->admin, 'end', chat: $closed)->assertStatus(409);
    }

    public function test_an_agent_resolves_their_offline_ticket_by_closing_it(): void
    {
        Event::fake([ConversationClosed::class, QueueChanged::class]);
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);

        $this->act($this->agent, 'close', chat: $ticket)->assertOk()->assertJsonPath('data.status', 'closed')->assertJsonPath('data.ratingRequested', false);

        $ticket->refresh();
        $this->assertSame(ConversationCloseReason::System, $ticket->close_reason);
        $this->assertNotNull($ticket->closed_at);
        $this->assertSame('closed', $ticket->events()->latest('id')->first()->type);
        Event::assertDispatched(ConversationClosed::class, fn (ConversationClosed $event): bool => $event->reason === ConversationCloseReason::System);
        Event::assertNotDispatched(QueueChanged::class);

        $this->act($this->agent, 'close', chat: $ticket)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_open');
    }

    public function test_an_agent_cannot_close_a_live_chat_or_a_ticket_that_is_not_theirs(): void
    {
        $ticket = Conversation::factory()->offline()->active($this->colleague)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $unclaimed = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);

        $this->act($this->agent, 'close')->assertForbidden();
        $this->act($this->agent, 'close', chat: $ticket)->assertForbidden();
        $this->act($this->agent, 'close', chat: $unclaimed)->assertForbidden();
        $this->assertSame(ConversationStatus::Active, $this->chat->fresh()->status);
        $this->assertSame(ConversationStatus::Queued, $unclaimed->fresh()->status);
    }

    public function test_an_admin_closes_any_open_conversation_including_a_queued_one(): void
    {
        Event::fake([ConversationClosed::class, QueueChanged::class]);
        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->colleague]);
        $ended = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id]);
        $unclaimed = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);

        $this->act($this->admin, 'close', chat: $queued)->assertOk()->assertJsonPath('data.status', 'closed');
        $this->assertSame(OfferResponse::Dismissed, ConversationOffer::query()->sole()->response);
        Event::assertDispatched(QueueChanged::class);

        $this->act($this->admin, 'close')->assertOk();
        $this->act($this->admin, 'close', chat: $ended)->assertOk();
        $this->act($this->admin, 'close', chat: $unclaimed)->assertOk();
        $this->assertSame(ConversationCloseReason::System, $this->chat->fresh()->close_reason);

        $closed = Conversation::factory()->closed($this->agent)->create(['widget_id' => $this->widget->id]);
        $this->act($this->admin, 'close', chat: $closed)->assertStatus(409);
    }

    public function test_the_chat_goes_to_another_category_through_the_routing_waves(): void
    {
        Event::fake([ConversationTransferred::class, ConversationQueued::class, QueueChanged::class, ChatOffered::class, ConversationAssigned::class]);
        ConversationOffer::factory()->answered(OfferResponse::Accepted)->create(['conversation_id' => $this->chat->id, 'user_id' => $this->agent->id]);
        $this->setPresence($this->salesAgent, PresenceStatus::Online);

        $this->act($this->agent, 'transfer', ['category' => 'sales'])
            ->assertOk()
            ->assertJsonPath('data.status', 'queued')
            ->assertJsonPath('data.assignedAgent', null)
            ->assertJsonPath('data.agent', null)
            ->assertJsonPath('data.category.slug', 'sales');

        $this->chat->refresh();
        $this->assertSame(ConversationStatus::Queued, $this->chat->status);
        $this->assertNull($this->chat->assigned_agent_id);
        $this->assertNull($this->chat->claimed_at);
        $this->assertNull($this->chat->idle_expires_at);
        $this->assertSame($this->sales->id, $this->chat->category_id);
        $this->assertTrue($this->chat->queue_expires_at->between(now()->addSeconds(85), now()->addSeconds(95)));
        $this->assertSame(1, $this->chat->wave);
        $this->assertSame([$this->salesAgent->id], ConversationOffer::query()->where('conversation_id', $this->chat->id)->where('response', null)->pluck('user_id')->all());

        $event = $this->chat->events()->where('type', 'transferred')->sole();
        $this->assertSame($this->agent->id, $event->payload['from_agent']);
        $this->assertSame($this->sales->ulid, $event->payload['to_category']);
        $this->assertSame($this->agent->id, $event->actor_id);

        Event::assertDispatched(ConversationTransferred::class, fn (ConversationTransferred $e): bool => $e->fromAgent?->is($this->agent) && $e->toAgent === null && $e->toCategory?->is($this->sales));
        Event::assertDispatched(ConversationQueued::class);
        Event::assertDispatched(QueueChanged::class);
        Event::assertDispatched(ChatOffered::class, fn (ChatOffered $e): bool => $e->offers->pluck('user_id')->all() === [$this->salesAgent->id]);
        Event::assertNotDispatched(ConversationAssigned::class);
    }

    public function test_the_agent_who_let_go_is_not_offered_the_chat_again(): void
    {
        $this->act($this->agent, 'transfer', ['category' => 'billing'])->assertOk();

        $offers = ConversationOffer::query()->where('conversation_id', $this->chat->id)->get();
        $this->assertSame([$this->colleague->id], $offers->whereNull('response')->pluck('user_id')->all());
        $this->assertSame(OfferResponse::Dismissed, $offers->firstWhere('user_id', $this->agent->id)->response);

        $this->actingAs($this->agent, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}")->assertForbidden();
        $this->actingAs($this->colleague, 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}")->assertOk();
    }

    public function test_the_chat_goes_to_a_colleague_who_alone_is_offered_it(): void
    {
        Event::fake([ConversationTransferred::class, ConversationAssigned::class, ChatOffered::class]);

        $this->act($this->agent, 'transfer', ['agent_id' => $this->colleague->id])->assertOk()->assertJsonPath('data.status', 'queued')->assertJsonPath('data.category.slug', 'billing');

        $open = ConversationOffer::query()->where('conversation_id', $this->chat->id)->whereNull('response')->get();
        $this->assertSame([$this->colleague->id], $open->pluck('user_id')->all());
        $this->assertTrue($open->sole()->expires_at->equalTo($this->chat->fresh()->queue_expires_at));
        Event::assertDispatched(ConversationTransferred::class, fn (ConversationTransferred $e): bool => $e->toAgent?->is($this->colleague));
        Event::assertDispatched(ConversationAssigned::class, fn (ConversationAssigned $e): bool => $e->agent->is($this->colleague) && $e->assignedBy?->is($this->agent) && $e->previousAgent?->is($this->agent));
        Event::assertNotDispatched(ChatOffered::class);

        // The colleague accepts it like any offer; the previous agent cannot take it back.
        $this->actingAs($this->agent, 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/claim")->assertForbidden();
        $this->actingAs($this->colleague, 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/claim")->assertOk()->assertJsonPath('data.assignedAgent.id', $this->colleague->id);
    }

    public function test_the_target_of_a_transfer_is_checked(): void
    {
        $inactive = $this->availableAgent($this->billing);
        $inactive->forceFill(['is_active' => false])->save();
        $notAgent = User::factory()->admin()->create(['is_agent' => false]);
        $otherTopic = $this->salesAgent;
        $inactiveCategory = Category::factory()->inactive()->create(['slug' => 'old']);
        $this->widget->categories()->attach($inactiveCategory->id, ['sort_order' => 3]);
        $elsewhere = Category::factory()->create(['slug' => 'elsewhere']);

        $this->act($this->agent, 'transfer', [])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['agent_id' => $this->colleague->id, 'category' => 'sales'])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['agent_id' => $this->agent->id])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['agent_id']]]);
        $this->act($this->agent, 'transfer', ['agent_id' => 999999])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['agent_id' => $inactive->id])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['agent_id' => $notAgent->id])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['agent_id' => $otherTopic->id])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['category' => 'nope'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['category']]]);
        $this->act($this->agent, 'transfer', ['category' => 'old'])->assertStatus(422);
        $this->act($this->agent, 'transfer', ['category' => 'elsewhere'])->assertStatus(422);

        $this->assertSame(ConversationStatus::Active, $this->chat->fresh()->status);
        $this->assertSame($this->agent->id, $this->chat->fresh()->assigned_agent_id);
    }

    public function test_only_the_agent_or_an_admin_may_transfer_and_only_an_active_chat(): void
    {
        $this->act($this->colleague, 'transfer', ['category' => 'sales'])->assertForbidden();
        $this->act($this->salesAgent, 'transfer', ['category' => 'sales'])->assertForbidden();

        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing);
        $ended = Conversation::factory()->ended($this->agent)->create(['widget_id' => $this->widget->id]);
        $this->act($this->admin, 'transfer', ['category' => 'sales'], $queued)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
        $this->act($this->agent, 'transfer', ['category' => 'sales'], $ended)->assertStatus(409);

        $this->act($this->admin, 'transfer', ['category' => 'sales'])->assertOk();
        $this->assertSame('admin', $this->chat->events()->where('type', 'transferred')->sole()->actor_type->value);
    }

    public function test_an_offline_ticket_goes_back_to_the_queue_without_offers(): void
    {
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);

        $this->act($this->agent, 'transfer', ['category' => 'sales'], $ticket)->assertOk()->assertJsonPath('data.status', 'queued')->assertJsonPath('data.type', 'offline');

        $this->assertNull($ticket->fresh()->queue_expires_at);
        $this->assertSame(0, ConversationOffer::query()->where('conversation_id', $ticket->id)->count());
        // It shows up for the agents of the new category.
        $this->actingAs($this->salesAgent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertJsonPath('data.0.ulid', $ticket->ulid);
    }
}
