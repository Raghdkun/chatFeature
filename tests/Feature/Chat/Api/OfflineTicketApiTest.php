<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\ConversationType;
use App\Domain\Chat\Events\OfflineTicketCreated;
use App\Domain\Chat\Events\QueueChanged;
use App\Domain\Visitors\IssuedVisitorToken;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `POST /public/offline-tickets` (decision P4-D2): a separate `type = offline` row, never an offer, linked to a missed chat in the
 * `created` event.
 */
class OfflineTicketApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    protected function setUp(): void
    {
        parent::setUp();

        config(['chat.rate_limits.public_offline_session' => 100, 'chat.rate_limits.public_offline_ip' => 100]);
        [$this->widget, $this->billing] = $this->chatWidget();
    }

    /**
     * @param  array<string, mixed>  $payload
     */
    private function leave(IssuedVisitorToken $token, array $payload = []): TestResponse
    {
        return $this->withToken($token->plaintext)->postJson('/api/v1/public/offline-tickets', $payload + ['name' => 'Ann', 'email' => 'ann@example.test', 'message' => 'Please call me back']);
    }

    public function test_a_visitor_leaves_a_message_that_becomes_an_offline_ticket(): void
    {
        Event::fake([OfflineTicketCreated::class, QueueChanged::class]);
        $token = $this->visitorSession($this->widget, ['name' => null, 'email' => null]);

        $response = $this->leave($token, ['category' => 'billing', 'message' => "  Hello\r\nagain  "])
            ->assertCreated()
            ->assertJsonPath('data.type', 'offline')
            ->assertJsonPath('data.status', 'queued')
            ->assertJsonPath('data.category.slug', 'billing')
            ->assertJsonPath('data.agent', null)
            ->assertJsonPath('data.lastSeq', 1);
        $this->assertStringNotContainsString('"id"', (string) $response->getContent());

        $ticket = Conversation::query()->where('ulid', $response->json('data.ulid'))->sole();
        $this->assertSame(ConversationType::Offline, $ticket->type);
        $this->assertSame(ConversationStatus::Queued, $ticket->status);
        $this->assertNull($ticket->queue_expires_at);
        $this->assertSame($token->session->id, $ticket->visitor_session_id);
        $this->assertSame("Hello\nagain", Message::query()->where('conversation_id', $ticket->id)->sole()->body);
        $this->assertSame(0, ConversationOffer::query()->count());
        $this->assertSame('Ann', $token->session->visitor->fresh()->name);
        $this->assertSame('ann@example.test', $token->session->visitor->fresh()->email);
        $this->assertNull($ticket->events()->where('type', 'created')->sole()->payload['origin']);

        Event::assertDispatched(OfflineTicketCreated::class);
        Event::assertDispatched(QueueChanged::class);
    }

    public function test_a_ticket_may_follow_up_on_the_visitors_own_missed_chat(): void
    {
        $token = $this->visitorSession($this->widget);
        $missed = Conversation::factory()->missed()->forCategory($this->billing)->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);

        $response = $this->leave($token, ['missed_conversation' => $missed->ulid])->assertCreated();

        $ticket = Conversation::query()->where('ulid', $response->json('data.ulid'))->sole();
        $this->assertNotSame($missed->id, $ticket->id, 'a missed chat stays missed: the ticket is a new row');
        $this->assertSame(ConversationStatus::Missed, $missed->fresh()->status);
        $this->assertSame($missed->ulid, $ticket->events()->where('type', 'created')->sole()->payload['origin']);
        $this->assertSame($this->billing->id, $ticket->category_id, 'the topic carries over');
    }

    public function test_a_ticket_without_a_topic_gets_the_first_active_topic_of_the_widget(): void
    {
        $sales = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $this->widget->categories()->attach($sales->id, ['sort_order' => 5]);
        $inactive = Category::factory()->create(['slug' => 'old', 'name' => 'Old', 'is_active' => false]);
        $this->widget->categories()->attach($inactive->id, ['sort_order' => -1]);

        $response = $this->leave($this->visitorSession($this->widget))->assertCreated()->assertJsonPath('data.category.slug', 'billing');

        $this->assertSame($this->billing->id, Conversation::query()->where('ulid', $response->json('data.ulid'))->sole()->category_id);
        // A topic that was sent wins; the missed chat's topic wins over the default.
        $this->leave($this->visitorSession($this->widget), ['category' => 'sales'])->assertCreated()->assertJsonPath('data.category.slug', 'sales');
        $token = $this->visitorSession($this->widget);
        $missed = Conversation::factory()->missed()->forCategory($sales)->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);
        $this->leave($token, ['missed_conversation' => $missed->ulid])->assertCreated()->assertJsonPath('data.category.slug', 'sales');
    }

    public function test_a_ticket_of_a_widget_without_topics_is_seen_and_taken_by_every_active_agent(): void
    {
        $this->widget->categories()->detach();
        $token = $this->visitorSession($this->widget);

        $response = $this->leave($token)->assertCreated()->assertJsonPath('data.category', null);
        $ulid = $response->json('data.ulid');
        $this->assertNull(Conversation::query()->where('ulid', $ulid)->sole()->category_id);

        $anAgent = User::factory()->agent()->create();
        $anotherAgent = User::factory()->agent()->create();
        $inactive = User::factory()->agent()->inactive()->create();
        $admin = User::factory()->admin()->create();

        foreach ([$anAgent, $anotherAgent, $admin] as $user) {
            $queue = array_column($this->actingAs($user, 'sanctum')->getJson('/api/v1/conversations/queue')->assertOk()->json('data'), 'ulid');
            $this->assertContains($ulid, $queue, $user->name.' sees the queued ticket');
            $this->actingAs($user, 'sanctum')->getJson("/api/v1/conversations/{$ulid}")->assertOk();
        }

        $this->assertNotContains($ulid, array_column($this->actingAs($inactive, 'sanctum')->getJson('/api/v1/conversations/queue')->json('data') ?? [], 'ulid'));
        $this->actingAs($anAgent, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertOk()->assertJsonPath('data.assignedAgent.id', $anAgent->id);
        $this->actingAs($anotherAgent, 'sanctum')->getJson("/api/v1/conversations/{$ulid}")->assertForbidden();
    }

    public function test_the_visitors_name_is_stored_as_one_line(): void
    {
        $token = $this->visitorSession($this->widget, ['name' => null]);

        $this->leave($token, ['name' => "Ann\r\nBcc: victim@example.test\u{202E}\t  Smith"])->assertCreated();

        $this->assertSame('Ann Bcc: victim@example.test Smith', $token->session->visitor->fresh()->name);
    }

    public function test_only_the_visitors_own_missed_live_chat_can_be_named(): void
    {
        $token = $this->visitorSession($this->widget);
        $stranger = $this->visitorSession($this->widget);
        $others = Conversation::factory()->missed()->create(['widget_id' => $this->widget->id, 'visitor_id' => $stranger->session->visitor_id, 'visitor_session_id' => $stranger->session->id]);
        $queued = $this->queuedChat($token, $this->billing);
        $offline = Conversation::factory()->offline()->create(['widget_id' => $this->widget->id, 'visitor_id' => $token->session->visitor_id, 'visitor_session_id' => $token->session->id]);

        foreach ([$others->ulid, $queued->ulid, $offline->ulid, '01JABCDEFGHJKMNPQRSTVWXYZ0'] as $ulid) {
            $this->leave($token, ['missed_conversation' => $ulid])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['missed_conversation']]]);
        }

        $this->leave($token, ['missed_conversation' => 'nope'])->assertStatus(422);
        $this->assertSame(0, Conversation::query()->where('type', 'offline')->where('ulid', '!=', $offline->ulid)->count());
    }

    public function test_the_form_is_validated(): void
    {
        settings()->set('chat.max_message_length', 100);
        $token = $this->visitorSession($this->widget);

        $this->withToken($token->plaintext)->postJson('/api/v1/public/offline-tickets', [])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['name', 'email', 'message']]]);
        $this->leave($token, ['email' => 'bad'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['email']]]);
        $this->leave($token, ['message' => str_repeat('x', 101)])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['message']]]);
        $this->leave($token, ['message' => "\x00 \u{202E}"])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['message']]]);
        $this->leave($token, ['category' => 'unknown'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['category']]]);
        $this->leave($token, ['name' => str_repeat('n', 121)])->assertStatus(422);

        $this->assertSame(0, Conversation::query()->count());
    }

    public function test_a_verified_visitor_keeps_the_address_the_identity_vouched_for(): void
    {
        $token = $this->visitorSession($this->widget, ['verified' => true, 'external_id' => 'u-1', 'name' => 'Verified Ann', 'email' => 'verified@example.test']);

        $this->leave($token, ['name' => 'Spoofed', 'email' => 'someone@else.test'])->assertCreated();

        $this->assertSame('verified@example.test', $token->session->visitor->fresh()->email);
        $this->assertSame('Verified Ann', $token->session->visitor->fresh()->name);
    }

    public function test_the_widget_can_switch_the_offline_form_off(): void
    {
        $config = $this->widget->config;
        $config['features']['offlineForm'] = false;
        $this->widget->forceFill(['config' => $config])->save();

        $this->leave($this->visitorSession($this->widget))->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');
        $this->assertSame(0, Conversation::query()->count());
    }

    public function test_offline_tickets_are_rate_limited(): void
    {
        config(['chat.rate_limits.public_offline_session' => 3]);
        $token = $this->visitorSession($this->widget);

        foreach (range(1, 3) as $i) {
            $this->leave($token)->assertCreated();
        }

        $this->leave($token)->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
        $this->assertSame(3, Conversation::query()->where('type', 'offline')->count());
    }

    public function test_it_needs_a_visitor_token_and_an_enabled_widget(): void
    {
        $this->postJson('/api/v1/public/offline-tickets', ['name' => 'a', 'email' => 'a@b.test', 'message' => 'x'])->assertStatus(401);

        $token = $this->visitorSession($this->widget);
        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->leave($token)->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
    }
}
