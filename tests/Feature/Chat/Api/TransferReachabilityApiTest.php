<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Events\ConversationTransferred;
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
 * A live chat is only handed to somebody who can take it (`409 no_agents`, the agent keeps the chat), and
 * `GET /conversations/{ulid}/transfer-targets` shows exactly what the transfer will accept.
 */
class TransferReachabilityApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private Category $sales;

    private User $agent;

    private User $colleague;

    private User $admin;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->sales = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $this->widget->categories()->attach($this->sales->id, ['sort_order' => 1]);
        $this->agent = $this->availableAgent($this->billing, ['name' => 'Sara Agent', 'email' => 'sara@secret.example']);
        $this->colleague = $this->availableAgent($this->billing, ['name' => 'Colin Colleague', 'email' => 'colin@secret.example']);
        $this->admin = User::factory()->admin()->create(['name' => 'Ada Admin']);
        $this->chat = $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->agent);
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function transfer(User $user, array $body, ?Conversation $chat = null): TestResponse
    {
        return $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.($chat ?? $this->chat)->ulid.'/transfer', $body);
    }

    private function targets(User $user, ?Conversation $chat = null): TestResponse
    {
        return $this->actingAs($user, 'sanctum')->getJson('/api/v1/conversations/'.($chat ?? $this->chat)->ulid.'/transfer-targets');
    }

    private function assertKeepsTheChat(): void
    {
        $this->chat->refresh();
        $this->assertSame(ConversationStatus::Active, $this->chat->status);
        $this->assertSame($this->agent->id, $this->chat->assigned_agent_id);
        $this->assertSame(0, $this->chat->events()->where('type', 'transferred')->count());
        $this->assertSame(0, ConversationOffer::query()->where('conversation_id', $this->chat->id)->count());
    }

    // ---- C4: the transfer itself --------------------------------------------------------------------------------------------

    public function test_a_chat_is_not_handed_to_an_offline_colleague(): void
    {
        Event::fake([ConversationTransferred::class]);
        $this->setPresence($this->colleague, PresenceStatus::Offline);

        $this->transfer($this->agent, ['agent_id' => $this->colleague->id])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'no_agents')
            ->assertJsonPath('error.details', ['target' => 'agent', 'reason' => 'offline']);

        // A heartbeat that stopped counts as offline too.
        $this->setPresence($this->colleague, PresenceStatus::Online, heartbeatSecondsAgo: 120);
        $this->transfer($this->agent, ['agent_id' => $this->colleague->id])->assertStatus(409)->assertJsonPath('error.details.reason', 'offline');

        $this->assertKeepsTheChat();
        Event::assertNotDispatched(ConversationTransferred::class);
    }

    public function test_a_chat_is_not_handed_to_a_colleague_who_is_full(): void
    {
        $this->colleague->forceFill(['max_concurrent_chats' => 1])->save();
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->colleague);

        $this->transfer($this->agent, ['agent_id' => $this->colleague->id])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'no_agents')
            ->assertJsonPath('error.details', ['target' => 'agent', 'reason' => 'at_capacity']);

        $this->assertKeepsTheChat();
    }

    public function test_an_away_colleague_with_room_can_take_the_chat(): void
    {
        $this->setPresence($this->colleague, PresenceStatus::Away);

        $this->transfer($this->agent, ['agent_id' => $this->colleague->id])->assertOk()->assertJsonPath('data.status', 'queued');
    }

    public function test_a_chat_is_not_handed_to_a_category_nobody_can_serve(): void
    {
        $salesAgent = $this->availableAgent($this->sales);
        $this->setPresence($salesAgent, PresenceStatus::Offline);

        $this->transfer($this->agent, ['category' => 'sales'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'no_agents')
            ->assertJsonPath('error.details', ['target' => 'category', 'reason' => 'no_reachable_agent']);
        $this->assertKeepsTheChat();

        // A full agent does not count either.
        $this->setPresence($salesAgent, PresenceStatus::Online);
        $salesAgent->forceFill(['max_concurrent_chats' => 1])->save();
        $this->activeChat($this->visitorSession($this->widget), $this->sales, $salesAgent);
        $this->transfer($this->agent, ['category' => 'sales'])->assertStatus(409);
        $this->assertKeepsTheChat();

        // With room again it goes through.
        $salesAgent->forceFill(['max_concurrent_chats' => 5])->save();
        $this->transfer($this->agent, ['category' => 'sales'])->assertOk();
    }

    public function test_the_agent_letting_go_and_the_person_transferring_do_not_count_as_somebody_to_serve_it(): void
    {
        // The only reachable agent of `sales` is the one who holds the chat (they serve both topics): handing it to `sales` would
        // dismiss the very agent it would be offered to.
        $this->sales->users()->attach($this->agent->id);
        $this->setPresence($this->colleague, PresenceStatus::Online);

        $this->transfer($this->agent, ['category' => 'sales'])->assertStatus(409)->assertJsonPath('error.details.target', 'category');
        $this->assertKeepsTheChat();

        // An admin who serves the topic and makes the transfer is not "somebody else" either.
        $adminAgent = User::factory()->admin()->create(['is_agent' => true]);
        $this->sales->users()->attach($adminAgent->id);
        $this->setPresence($adminAgent, PresenceStatus::Online);
        $this->transfer($adminAgent, ['category' => 'sales'])->assertStatus(409);

        // Once a colleague serves it, it works.
        $this->sales->users()->attach($this->colleague->id);
        $this->transfer($this->agent, ['category' => 'sales'])->assertOk();
    }

    public function test_the_category_check_follows_the_widgets_routing_waves(): void
    {
        $config = $this->widget->config;
        $config['routing']['waves'] = [['afterSeconds' => 0, 'statuses' => ['online']]];
        $this->widget->forceFill(['config' => $config])->save();
        $salesAgent = $this->availableAgent($this->sales, status: PresenceStatus::Away);

        // Nobody is offered a chat by a plan that only knows `online`: an away agent is not somebody to serve it.
        $this->transfer($this->agent, ['category' => 'sales'])->assertStatus(409);

        $this->setPresence($salesAgent, PresenceStatus::Online);
        $this->transfer($this->agent, ['category' => 'sales'])->assertOk();
    }

    public function test_an_offline_ticket_is_transferred_without_the_check(): void
    {
        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);

        $this->transfer($this->agent, ['category' => 'sales'], $ticket)->assertOk()->assertJsonPath('data.status', 'queued');
    }

    // ---- B1: the transfer targets -------------------------------------------------------------------------------------------

    public function test_the_targets_list_the_colleagues_and_the_categories_that_can_take_the_chat(): void
    {
        $away = $this->availableAgent($this->billing, ['name' => 'Ava Away'], PresenceStatus::Away);
        $offline = $this->availableAgent($this->billing, ['name' => 'Otto Offline'], PresenceStatus::Offline);
        $full = $this->availableAgent($this->billing, ['name' => 'Fay Full', 'max_concurrent_chats' => 2]);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $full);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $full);
        $this->availableAgent($this->sales, ['name' => 'Sam Sales']);
        $otherTopic = $this->availableAgent($this->sales, ['name' => 'Not In Billing']);
        $inactive = $this->availableAgent($this->billing, ['name' => 'Ina Inactive']);
        $inactive->forceFill(['is_active' => false])->save();
        $notAnAgent = User::factory()->admin()->create(['name' => 'Nora Notagent', 'is_agent' => false]);
        $this->billing->users()->attach($notAnAgent->id);

        $response = $this->targets($this->agent)->assertOk();

        $agents = collect($response->json('data.agents'))->keyBy('name');
        $this->assertSame(['Ava Away', 'Colin Colleague', 'Fay Full', 'Otto Offline'], $agents->keys()->sort()->values()->all(), 'active agents of the chat\'s topic, not the caller');
        $this->assertSame(['id', 'name', 'avatarUrl', 'status', 'activeChats', 'maxConcurrentChats', 'reachable'], array_keys($agents['Colin Colleague']));
        $this->assertSame(['online', 0, 5, true], [$agents['Colin Colleague']['status'], $agents['Colin Colleague']['activeChats'], $agents['Colin Colleague']['maxConcurrentChats'], $agents['Colin Colleague']['reachable']]);
        $this->assertSame(['away', true], [$agents['Ava Away']['status'], $agents['Ava Away']['reachable']]);
        $this->assertSame(['offline', false], [$agents['Otto Offline']['status'], $agents['Otto Offline']['reachable']]);
        $this->assertSame(['online', 2, 2, false], [$agents['Fay Full']['status'], $agents['Fay Full']['activeChats'], $agents['Fay Full']['maxConcurrentChats'], $agents['Fay Full']['reachable']]);
        $this->assertSame($away->id, $agents['Ava Away']['id']);
        $this->assertSame($offline->id, $agents['Otto Offline']['id']);
        $this->assertNotContains($otherTopic->id, collect($response->json('data.agents'))->pluck('id')->all());

        // Only `sales` can take the chat: it has an agent who is reachable; billing is the chat's own topic.
        $this->assertSame([['slug' => 'sales', 'label' => 'Sales']], $response->json('data.categories'));

        // Privacy: staff names and loads, never an address.
        $this->assertStringNotContainsString('@', (string) $response->getContent());
    }

    public function test_a_category_without_a_reachable_agent_is_not_offered(): void
    {
        $salesAgent = $this->availableAgent($this->sales, status: PresenceStatus::Offline);
        $inactiveTopic = Category::factory()->create(['slug' => 'old', 'name' => 'Old', 'is_active' => false]);
        $this->widget->categories()->attach($inactiveTopic->id, ['sort_order' => 2]);
        $elsewhere = Category::factory()->create(['slug' => 'elsewhere', 'name' => 'Elsewhere']);
        $this->availableAgent($elsewhere);

        $this->assertSame([], $this->targets($this->agent)->assertOk()->json('data.categories'));

        $this->setPresence($salesAgent, PresenceStatus::Online);
        $this->assertSame([['slug' => 'sales', 'label' => 'Sales']], $this->targets($this->agent)->json('data.categories'));
    }

    public function test_an_admin_looking_at_somebody_elses_chat_does_not_get_that_agent_as_a_target(): void
    {
        $agents = collect($this->targets($this->admin)->assertOk()->json('data.agents'))->pluck('name')->all();

        $this->assertSame(['Colin Colleague'], $agents, 'the agent who has the chat is not a target; the admin is not an agent');
    }

    public function test_what_the_targets_call_reachable_is_what_the_transfer_accepts(): void
    {
        $this->setPresence($this->colleague, PresenceStatus::Offline);
        $away = $this->availableAgent($this->billing, status: PresenceStatus::Away);
        $full = $this->availableAgent($this->billing, ['max_concurrent_chats' => 1]);
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $full);
        $stale = $this->availableAgent($this->billing);
        $this->setPresence($stale, PresenceStatus::Online, heartbeatSecondsAgo: 200);

        $targets = collect($this->targets($this->agent)->assertOk()->json('data.agents'));
        $this->assertCount(4, $targets);

        foreach ($targets as $target) {
            $chat = $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->agent);
            $response = $this->transfer($this->agent, ['agent_id' => $target['id']], $chat);

            $this->assertSame($target['reachable'] ? 200 : 409, $response->status(), 'agent '.$target['name'].' '.json_encode($target));
        }

        $this->assertTrue($targets->firstWhere('id', $away->id)['reachable']);
        $this->assertFalse($targets->firstWhere('id', $full->id)['reachable']);
        $this->assertFalse($targets->firstWhere('id', $stale->id)['reachable']);
    }

    public function test_the_targets_are_for_active_live_chats_the_caller_may_see(): void
    {
        $this->getJson("/api/v1/conversations/{$this->chat->ulid}/transfer-targets")->assertUnauthorized();

        $stranger = $this->availableAgent($this->billing);
        $this->targets($stranger)->assertForbidden();
        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->getJson("/api/v1/conversations/{$this->chat->ulid}/transfer-targets")->assertForbidden();

        $ticket = Conversation::factory()->offline()->active($this->agent)->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $this->targets($this->agent, $ticket)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_live');

        $queued = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$stranger]);
        $this->targets($stranger, $queued)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');

        $closed = Conversation::factory()->closed($this->agent)->create(['widget_id' => $this->widget->id]);
        $this->targets($this->agent, $closed)->assertStatus(409);

        $this->targets($this->agent)->assertOk();
    }
}
