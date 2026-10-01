<?php

namespace Tests\Feature\Chat;

use App\Mail\OfflineTicketReply;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * The whole life of a conversation through the public and management APIs and the timers, in the order real traffic does it:
 * queued -> active -> ended -> closed, queued -> missed -> offline ticket -> closed, active -> queued (transfer) -> active -> idle.
 */
class ConversationLifecycleTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private Category $sales;

    private User $sara;

    private User $colin;

    private User $salesAgent;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->sales = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales']);
        $this->widget->categories()->attach($this->sales->id, ['sort_order' => 1]);
        $this->sara = $this->availableAgent($this->billing, ['name' => 'Sara']);
        $this->colin = $this->availableAgent($this->billing, ['name' => 'Colin']);
        $this->salesAgent = $this->availableAgent($this->sales, ['name' => 'Sam']);
    }

    /**
     * @return list<string>
     */
    private function trail(Conversation $conversation): array
    {
        return $conversation->events()->pluck('type')->all();
    }

    public function test_a_chat_from_the_first_message_to_the_rating(): void
    {
        $visitor = $this->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions', [], ['Origin' => self::CUSTOMER_ORIGIN])->assertCreated()->json('data.visitorToken');
        $ulid = $this->withToken($visitor)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann', 'message' => 'My invoice is wrong'])->assertCreated()->json('data.ulid');
        $chat = Conversation::query()->where('ulid', $ulid)->firstOrFail();

        // Both billing agents were offered the chat; Sara accepts first.
        $this->actingAs($this->sara, 'sanctum')->getJson('/api/v1/conversations/queue')->assertJsonPath('data.0.ulid', $ulid)->assertJsonPath('data.0.unseenByAgent', 1);
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertOk();
        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertStatus(409);
        $this->withToken($visitor)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'active')->assertJsonPath('data.agent.name', 'Sara');

        // The agent reads, answers; the visitor answers back and reads.
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/receipts", ['seen_upto' => 1])->assertNoContent();
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/messages", ['client_msg_id' => (string) Str::ulid(), 'body' => 'Let me look into it'])->assertCreated();
        $this->withToken($visitor)->postJson("/api/v1/public/conversations/{$ulid}/receipts", ['seen_upto' => 3])->assertNoContent();
        $this->withToken($visitor)->postJson("/api/v1/public/conversations/{$ulid}/messages", ['client_msg_id' => (string) Str::ulid(), 'body' => 'Thanks'])->assertCreated()->assertJsonPath('data.seq', 4);

        $sync = $this->withToken($visitor)->getJson("/api/v1/public/conversations/{$ulid}/messages?after_seq=0")->assertOk();
        $this->assertSame([1, 2, 3, 4], array_column($sync->json('data'), 'seq'));
        $this->assertSame(['visitor', 'system', 'agent', 'visitor'], array_map(fn (array $m): string => $m['sender']['type'], $sync->json('data')));
        $this->assertNotNull($sync->json('data.2.seenAt'), 'the visitor saw the agent message');
        $this->assertNotNull($sync->json('data.0.seenAt'), 'the agent saw the visitor message');

        $chat->refresh();
        $this->assertSame(4, $chat->last_seq);
        $this->assertSame(1, $chat->unseen_by_agent);
        $this->assertSame(0, $chat->unseen_by_visitor);

        // The agent ends it; the visitor rates.
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/end")->assertOk()->assertJsonPath('data.status', 'ended');
        $this->withToken($visitor)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'ended')->assertJsonPath('data.ratingRequested', true);
        $this->withToken($visitor)->postJson("/api/v1/public/conversations/{$ulid}/rating", ['score' => 5, 'comment' => 'Quick and friendly'])->assertCreated();
        $this->withToken($visitor)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'closed');

        $this->assertSame(['created', 'offered', 'claimed', 'ended', 'rated'], $this->trail($chat));
        $this->assertSame(5, Rating::query()->sole()->score);

        // The conversation is over: nothing more goes in, and the visitor can start a fresh chat.
        $this->withToken($visitor)->postJson("/api/v1/public/conversations/{$ulid}/messages", ['body' => 'one more thing'])->assertStatus(409);
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/messages", ['body' => 'bye'])->assertStatus(409);
        $this->withToken($visitor)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann'])->assertCreated();
    }

    public function test_a_missed_chat_becomes_an_offline_ticket_that_staff_answer_and_close(): void
    {
        Mail::fake();
        $token = $this->visitorSession($this->widget);
        $ulid = $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann', 'message' => 'Anybody there?'])->assertCreated()->json('data.ulid');
        $missed = Conversation::query()->where('ulid', $ulid)->firstOrFail();

        // Nobody accepts within the queue timeout.
        $this->travel(2)->minutes();
        $this->artisan('chat:expire-queued')->assertSuccessful();
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'missed');
        $this->assertSame(['created', 'offered', 'missed'], $this->trail($missed));
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_queued');

        // The visitor leaves a message instead; it is a new conversation linked to the missed one.
        $ticketUlid = $this->withToken($token->plaintext)->postJson('/api/v1/public/offline-tickets', ['name' => 'Ann', 'email' => 'ann@example.test', 'message' => 'Please call me', 'missed_conversation' => $ulid])->assertCreated()->json('data.ulid');
        $ticket = Conversation::query()->where('ulid', $ticketUlid)->firstOrFail();
        $this->assertSame($ulid, $ticket->events()->first()->payload['origin']);

        // It appears in the queue of the agents of its category; one claims it and replies.
        $this->actingAs($this->colin, 'sanctum')->getJson('/api/v1/conversations/queue')->assertJsonPath('data.0.ulid', $ticketUlid)->assertJsonPath('data.0.type', 'offline');
        $this->actingAs($this->salesAgent, 'sanctum')->getJson('/api/v1/conversations/queue')->assertJsonCount(0, 'data');
        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ticketUlid}/claim")->assertOk();
        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ticketUlid}/messages", ['body' => 'Calling you now.'])->assertCreated();
        Mail::assertQueued(OfflineTicketReply::class, fn (OfflineTicketReply $mail): bool => $mail->hasTo('ann@example.test'));

        // An offline ticket never idles out, however long it sits.
        $this->travel(5)->days();
        $this->artisan('chat:close-idle')->assertSuccessful();
        $this->assertSame('active', $ticket->fresh()->status->value);

        $this->actingAs($this->colin, 'sanctum')->postJson("/api/v1/conversations/{$ticketUlid}/close")->assertOk()->assertJsonPath('data.status', 'closed');
        $this->assertSame(['created', 'claimed', 'closed'], $this->trail($ticket));
        $this->assertSame('system', $ticket->fresh()->close_reason->value);
        $this->assertSame(2, Message::query()->where('conversation_id', $ticket->id)->where('sender_type', '!=', 'system')->count());
    }

    public function test_a_transferred_chat_is_taken_by_another_agent_and_finally_goes_idle(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->sara);
        $ulid = $chat->ulid;

        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/transfer", ['category' => 'sales'])->assertOk();
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'queued')->assertJsonPath('data.agent', null)->assertJsonPath('data.category.slug', 'sales');
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$ulid}/messages", ['body' => 'hello?'])->assertStatus(409);

        $this->actingAs($this->salesAgent, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertOk();
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'active')->assertJsonPath('data.agent.name', 'Sam');
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$ulid}/messages", ['body' => 'hello Sam'])->assertCreated();

        $this->travel(121)->minutes();
        $this->artisan('chat:close-idle')->expectsOutputToContain('Closed 1 idle chat(s).')->assertSuccessful();
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertJsonPath('data.status', 'closed')->assertJsonPath('data.ratingRequested', false);

        $this->assertSame(['transferred', 'offered', 'claimed', 'closed'], $this->trail($chat));
    }

    public function test_a_visitor_who_gives_up_while_waiting_cancels(): void
    {
        $token = $this->visitorSession($this->widget);
        $ulid = $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'name' => 'Ann'])->assertCreated()->json('data.ulid');

        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$ulid}/cancel")->assertOk()->assertJsonPath('data.status', 'closed');
        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$ulid}/claim")->assertStatus(409);
        $this->actingAs($this->sara, 'sanctum')->getJson('/api/v1/conversations/queue')->assertJsonCount(0, 'data');

        // Nobody is left to expire it.
        $this->travel(2)->minutes();
        $this->artisan('chat:expire-queued')->expectsOutputToContain('Marked 0 queued chat(s) as missed.')->assertSuccessful();
        $this->assertSame('closed', Conversation::query()->where('ulid', $ulid)->firstOrFail()->status->value);
    }

    public function test_an_ended_chat_closes_by_itself_when_nobody_rates(): void
    {
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $this->billing, $this->sara);

        $this->actingAs($this->sara, 'sanctum')->postJson("/api/v1/conversations/{$chat->ulid}/end")->assertOk();

        $this->travel(11)->minutes();
        $this->artisan('chat:close-unrated')->assertSuccessful();
        $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/rating", ['score' => 5])->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_ended');
        $this->assertSame('timeout', $chat->fresh()->close_reason->value);
        $this->assertSame(0, Rating::query()->count());
    }
}
