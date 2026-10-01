<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Actions\ClaimConversation;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Chat\Enums\OfferResponse;
use App\Domain\Chat\Events\ChatTaken;
use App\Domain\Chat\Events\ConversationClaimed;
use App\Domain\Chat\Events\MessageCreated;
use App\Domain\Chat\Events\QueueChanged;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `POST /conversations/{ulid}/claim`: the first accept wins (decision P4-D5) under the eligibility rules.
 */
class ClaimConversationApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private User $winner;

    private User $loser;

    private Conversation $chat;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget, $this->billing] = $this->chatWidget();
        $this->winner = $this->availableAgent($this->billing, ['name' => 'Winner Wendy']);
        $this->loser = $this->availableAgent($this->billing, ['name' => 'Loser Larry']);
        $token = $this->visitorSession($this->widget, ['name' => 'Ann']);
        $this->chat = $this->queuedChat($token, $this->billing, [$this->winner, $this->loser]);
    }

    private function claim(User $user, ?Conversation $chat = null): TestResponse
    {
        return $this->actingAs($user, 'sanctum')->postJson('/api/v1/conversations/'.($chat ?? $this->chat)->ulid.'/claim');
    }

    public function test_the_first_accept_wins_and_everyone_else_is_told(): void
    {
        Event::fake([ConversationClaimed::class, ChatTaken::class, QueueChanged::class, MessageCreated::class]);

        $response = $this->claim($this->winner)->assertOk()
            ->assertJsonPath('data.status', 'active')
            ->assertJsonPath('data.assignedAgent', ['id' => $this->winner->id, 'name' => 'Winner Wendy'])
            ->assertJsonPath('data.agent.name', 'Winner Wendy')
            ->assertJsonPath('data.unseenByAgent', 0);
        $this->assertNotNull($response->json('data.claimedAt'));

        $this->chat->refresh();
        $this->assertSame(ConversationStatus::Active, $this->chat->status);
        $this->assertSame($this->winner->id, $this->chat->assigned_agent_id);
        $this->assertSame(1, $this->chat->claim_version);
        $this->assertNotNull($this->chat->claimed_at);
        $this->assertEqualsWithDelta(now()->addMinutes(120)->getTimestamp(), $this->chat->idle_expires_at->getTimestamp(), 2);

        $this->assertSame(OfferResponse::Accepted, ConversationOffer::query()->where('user_id', $this->winner->id)->sole()->response);
        $lost = ConversationOffer::query()->where('user_id', $this->loser->id)->sole();
        $this->assertSame(OfferResponse::Taken, $lost->response);
        $this->assertNotNull($lost->responded_at);

        $this->assertSame('claimed', $this->chat->events()->latest('id')->first()->type);
        $joined = Message::query()->where('conversation_id', $this->chat->id)->sole();
        $this->assertSame('system', $joined->sender_type->value);
        $this->assertSame('Winner Wendy joined the chat.', $joined->body);
        $this->assertSame(1, $this->chat->last_seq);

        Event::assertDispatched(ConversationClaimed::class, fn (ConversationClaimed $event): bool => $event->agent->is($this->winner));
        Event::assertDispatched(ChatTaken::class, fn (ChatTaken $event): bool => $event->claimedBy->is($this->winner) && $event->otherOfferedUserIds === [$this->loser->id]);
        Event::assertDispatched(QueueChanged::class);
        Event::assertDispatched(MessageCreated::class, fn (MessageCreated $event): bool => $event->message->is($joined));
    }

    public function test_the_loser_gets_409_with_the_winners_name(): void
    {
        $this->claim($this->winner)->assertOk();

        $this->claim($this->loser)->assertStatus(409)
            ->assertJsonPath('error.code', 'already_claimed')
            ->assertJsonPath('error.details.by', 'Winner Wendy');

        $this->assertSame($this->winner->id, $this->chat->fresh()->assigned_agent_id);
        $this->assertSame(1, $this->chat->fresh()->claim_version);
    }

    public function test_the_loser_of_a_simultaneous_accept_is_told_409_not_403_when_the_winner_commits_between_the_checks(): void
    {
        $winner = $this->winner;
        $chat = $this->chat;
        $fired = false;

        // The winner's accept lands right after the loser's action has read the chat (still queued) and before it looks at the offers
        // again: the winner has closed them as taken by then, so the offer check alone would say "not offered to you".
        DB::listen(function ($query) use (&$fired, $winner, $chat): void {
            if ($fired || ! str_starts_with(strtolower($query->sql), 'select') || ! str_contains($query->sql, 'conversations')) {
                return;
            }

            $fired = true;
            Conversation::query()->whereKey($chat->id)->update(['status' => ConversationStatus::Active->value, 'assigned_agent_id' => $winner->id]);
            ConversationOffer::query()->where('conversation_id', $chat->id)->update(['responded_at' => now(), 'response' => OfferResponse::Taken->value]);
        });

        try {
            app(ClaimConversation::class)->handle($chat, $this->loser);
            $this->fail('The loser must not get the chat.');
        } catch (ApiProblemException $problem) {
            $this->assertSame(409, $problem->getStatusCode());
            $this->assertSame('already_claimed', $problem->errorCode());
        }

        $this->assertTrue($fired);
    }

    public function test_accepting_your_own_chat_again_is_idempotent(): void
    {
        $this->claim($this->winner)->assertOk();
        Event::fake([ConversationClaimed::class, ChatTaken::class, QueueChanged::class, MessageCreated::class]);

        // Two tabs, a double click, a retried request: the same agent gets the conversation back and nothing happens twice.
        $this->claim($this->winner)->assertOk()
            ->assertJsonPath('data.ulid', $this->chat->ulid)
            ->assertJsonPath('data.status', 'active')
            ->assertJsonPath('data.assignedAgent.id', $this->winner->id);

        Event::assertNotDispatched(ConversationClaimed::class);
        Event::assertNotDispatched(ChatTaken::class);
        Event::assertNotDispatched(QueueChanged::class);
        Event::assertNotDispatched(MessageCreated::class);
        $this->assertSame(1, $this->chat->fresh()->claim_version);
        $this->assertSame(1, Message::query()->where('conversation_id', $this->chat->id)->count(), 'one "joined" line');
        $this->assertSame(1, ConversationOffer::query()->where('response', 'accepted')->count());

        // Somebody else still gets the conflict.
        $this->claim($this->loser)->assertStatus(409)->assertJsonPath('error.code', 'already_claimed')->assertJsonPath('error.details.by', 'Winner Wendy');
    }

    public function test_an_agent_at_capacity_re_accepting_their_own_chat_is_not_told_they_are_full(): void
    {
        $this->winner->forceFill(['max_concurrent_chats' => 1])->save();
        $this->claim($this->winner)->assertOk();

        $this->claim($this->winner)->assertOk()->assertJsonPath('data.status', 'active');

        // A different chat is what the capacity rule is about.
        $other = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->winner]);
        $this->claim($this->winner, $other)->assertStatus(409)->assertJsonPath('error.code', 'at_capacity');
    }

    public function test_only_an_agent_who_was_offered_the_chat_may_claim_it(): void
    {
        $this->postJson("/api/v1/conversations/{$this->chat->ulid}/claim")->assertUnauthorized();

        $stranger = $this->availableAgent($this->billing);
        $nonAgentAdmin = User::factory()->admin()->create(['is_agent' => false]);
        $offline = $this->availableAgent($this->billing);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $this->chat->id, 'user_id' => $offline->id]);

        $this->claim($stranger)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->claim($offline)->assertForbidden();
        $this->claim($nonAgentAdmin)->assertForbidden();
        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->postJson("/api/v1/conversations/{$this->chat->ulid}/claim")->assertForbidden();

        $this->assertSame(ConversationStatus::Queued, $this->chat->fresh()->status);
        $this->assertNull($this->chat->fresh()->assigned_agent_id);
    }

    public function test_an_admin_who_takes_chats_may_claim_without_an_offer(): void
    {
        $admin = User::factory()->admin()->create();

        $this->claim($admin)->assertOk()->assertJsonPath('data.assignedAgent.id', $admin->id);
        // The agents who held offers are told, the admin had none.
        $this->assertSame(2, ConversationOffer::query()->where('response', 'taken')->count());
    }

    public function test_an_agent_who_stopped_serving_the_category_cannot_claim(): void
    {
        $this->billing->users()->detach($this->winner->id);

        $this->claim($this->winner)->assertForbidden();
        $this->assertSame(ConversationStatus::Queued, $this->chat->fresh()->status);
    }

    public function test_capacity_is_checked_against_live_chats_only(): void
    {
        $this->winner->forceFill(['max_concurrent_chats' => 1])->save();
        $this->activeChat($this->visitorSession($this->widget), $this->billing, $this->winner);

        $this->claim($this->winner)->assertStatus(409)->assertJsonPath('error.code', 'at_capacity');
        $this->assertSame(ConversationStatus::Queued, $this->chat->fresh()->status);
        $this->assertNull(ConversationOffer::query()->where('user_id', $this->winner->id)->value('response'));

        // Another agent is unaffected; an offline ticket takes no slot.
        $this->claim($this->loser)->assertOk();
        $this->loser->forceFill(['max_concurrent_chats' => 1])->save();
        Conversation::factory()->offline()->active($this->loser)->create(['widget_id' => $this->widget->id, 'category_id' => $this->billing->id]);
        $second = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->loser]);
        $this->claim($this->loser, $second)->assertStatus(409)->assertJsonPath('error.code', 'at_capacity');

        // Capacity only limits live chats: a busy agent can still pick up an offline ticket.
        $ticket = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $this->claim($this->loser, $ticket)->assertOk()->assertJsonPath('data.status', 'active');

        $this->loser->forceFill(['max_concurrent_chats' => 3])->save();
        $this->claim($this->loser, $second)->assertOk();
    }

    public function test_a_chat_that_is_no_longer_queued_cannot_be_claimed(): void
    {
        $cancelled = $this->queuedChat($this->visitorSession($this->widget), $this->billing, [$this->winner], ['status' => 'closed', 'close_reason' => 'cancelled']);
        $missed = Conversation::factory()->missed()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        ConversationOffer::factory()->expired()->create(['conversation_id' => $missed->id, 'user_id' => $this->winner->id]);

        // An offered agent is told it is gone (so the client drops the offer); anyone else learns nothing.
        $this->claim($this->winner, $cancelled)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_queued');
        $this->claim($this->winner, $missed)->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_queued');
        $this->claim($this->availableAgent($this->billing), $cancelled)->assertForbidden();
    }

    public function test_an_offline_ticket_is_claimed_by_an_agent_of_its_category_without_a_join_line(): void
    {
        $ticket = Conversation::factory()->offline()->forCategory($this->billing)->create(['widget_id' => $this->widget->id]);
        $sales = $this->availableAgent(Category::factory()->create(['slug' => 'sales']));

        $this->claim($sales, $ticket)->assertForbidden();
        $this->claim($this->winner, $ticket)->assertOk()->assertJsonPath('data.status', 'active')->assertJsonPath('data.type', 'offline');

        $ticket->refresh();
        $this->assertSame($this->winner->id, $ticket->assigned_agent_id);
        $this->assertNull($ticket->idle_expires_at, 'an offline ticket never idles out');
        $this->assertSame(0, Message::query()->where('conversation_id', $ticket->id)->count());
    }

    public function test_a_claim_needs_a_known_conversation(): void
    {
        $this->actingAs($this->winner, 'sanctum')->postJson('/api/v1/conversations/01JABCDEFGHJKMNPQRSTVWXYZ0/claim')->assertNotFound();
    }
}
