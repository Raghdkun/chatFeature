<?php

namespace Tests\Feature\Dashboard;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Enums\SenderType;
use App\Models\AgentPresence;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\FakeAttachmentUrls;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The inbox pages: who may open them, which conversations each role is handed, the props of docs/contracts/chat-ui-p4.md and the
 * 403 for an agent that opens a chat that is not theirs.
 */
class ChatInboxPagesTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        $this->app->instance(AttachmentUrls::class, new FakeAttachmentUrls);
    }

    public function test_the_inbox_needs_a_signed_in_member_of_staff(): void
    {
        $this->get('/inbox')->assertRedirect(route('login'));
        $this->get('/inbox/'.Conversation::factory()->create()->ulid)->assertRedirect(route('login'));
        // No chat role / deactivated: the session is ended and the browser is sent to the sign-in page.
        $this->actingAs(User::factory()->withoutChatAccess()->create())->get('/inbox')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->inactive()->create())->get('/inbox')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->agent()->create())->get('/inbox')->assertOk();
        $this->actingAs(User::factory()->admin()->create())->get('/inbox')->assertOk();
    }

    public function test_an_agent_is_handed_only_the_chats_offered_or_assigned_to_them(): void
    {
        $agent = User::factory()->agent()->create(['name' => 'Ada']);
        $colleague = User::factory()->agent()->create();

        $offered = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offered->id, 'user_id' => $agent->id]);
        $offeredToColleague = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $offeredToColleague->id, 'user_id' => $colleague->id]);
        $expiredOffer = Conversation::factory()->create();
        ConversationOffer::factory()->expired()->create(['conversation_id' => $expiredOffer->id, 'user_id' => $agent->id]);

        $mine = Conversation::factory()->active($agent)->create(['last_activity_at' => now()->subMinutes(5)]);
        $newest = Conversation::factory()->active($agent)->create(['last_activity_at' => now()]);
        $ended = Conversation::factory()->ended($agent)->create(['last_activity_at' => now()->subMinutes(10)]);
        $theirs = Conversation::factory()->active($colleague)->create();

        $this->actingAs($agent)->get('/inbox')->assertInertia(fn (Assert $page) => $page
            ->component('inbox/index')
            ->has('queue', 1)
            ->where('queue.0.ulid', $offered->ulid)
            ->where('queue.0.status', 'queued')
            ->has('mine', 3)
            ->where('mine.0.ulid', $newest->ulid)
            ->where('mine.1.ulid', $mine->ulid)
            ->where('mine.2.ulid', $ended->ulid)
            ->where('mine.0.assignedAgent.id', $agent->id)
            ->where('presence.status', 'offline')
            ->has('categories')
            ->missing('conversation')
            ->etc());

        $this->assertNotContains($theirs->ulid, collect($this->actingAs($agent)->get('/inbox')->viewData('page')['props']['mine'])->pluck('ulid')->all());
    }

    public function test_an_admin_sees_every_live_chat_and_the_queue(): void
    {
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();
        $first = Conversation::factory()->create(['queued_at' => now()->subMinute()]);
        $second = Conversation::factory()->create(['queued_at' => now()]);
        $active = Conversation::factory()->active($agent)->create();
        Conversation::factory()->missed()->create();
        Conversation::factory()->offline()->create();

        $this->actingAs($admin)->get('/inbox')->assertInertia(fn (Assert $page) => $page
            ->has('queue', 2)
            ->where('queue.0.ulid', $first->ulid)
            ->where('queue.1.ulid', $second->ulid)
            ->has('mine', 1)
            ->where('mine.0.ulid', $active->ulid)
            ->etc());
    }

    public function test_closed_chats_stay_in_my_chats_for_half_a_day(): void
    {
        $agent = User::factory()->agent()->create();
        $recent = Conversation::factory()->closed($agent)->create(['closed_at' => now()->subHours(2)]);
        Conversation::factory()->closed($agent)->create(['closed_at' => now()->subHours(30)]);

        $this->actingAs($agent)->get('/inbox')->assertInertia(fn (Assert $page) => $page
            ->has('mine', 1)
            ->where('mine.0.ulid', $recent->ulid)
            ->etc());
    }

    public function test_the_lists_carry_staff_details_and_the_presence_of_the_caller(): void
    {
        $agent = User::factory()->agent()->create();
        AgentPresence::factory()->create(['user_id' => $agent->id, 'status' => PresenceStatus::Away]);
        $conversation = Conversation::factory()->active($agent)->create(['unseen_by_agent' => 3, 'last_message_preview' => 'Hello there']);

        $this->actingAs($agent)->get('/inbox')->assertInertia(fn (Assert $page) => $page
            ->where('presence.status', 'away')
            ->where('mine.0.ulid', $conversation->ulid)
            ->where('mine.0.unseenByAgent', 3)
            ->where('mine.0.lastMessagePreview', 'Hello there')
            ->has('mine.0.visitor.email')
            ->has('mine.0.widget.name')
            ->etc());
    }

    public function test_agents_get_active_categories_and_admins_all_of_them(): void
    {
        Category::factory()->create(['name' => 'Active one']);
        Category::factory()->create(['name' => 'Dormant', 'is_active' => false]);

        $this->actingAs(User::factory()->agent()->create())->get('/inbox')
            ->assertInertia(fn (Assert $page) => $page->has('categories', 1)->where('categories.0.name', 'Active one')->etc());
        $this->actingAs(User::factory()->admin()->create())->get('/inbox')
            ->assertInertia(fn (Assert $page) => $page->has('categories', 2)->etc());
    }

    public function test_an_assigned_agent_opens_their_chat_with_the_whole_transcript(): void
    {
        $agent = User::factory()->agent()->create(['name' => 'Ada']);
        $conversation = Conversation::factory()->active($agent)->create();
        Message::factory()->for($conversation)->create(['body' => 'Hi', 'client_msg_id' => '01JTESTCLIENTMSG000000000A']);
        Message::factory()->for($conversation)->create(['sender_type' => SenderType::Agent, 'sender_user_id' => $agent->id, 'body' => 'Hello!']);
        Message::factory()->for($conversation)->system()->create();
        Message::factory()->for($conversation)->image()->create();

        $this->actingAs($agent)->get('/inbox/'.$conversation->ulid)->assertInertia(fn (Assert $page) => $page
            ->component('inbox/show')
            ->where('conversation.ulid', $conversation->ulid)
            ->where('conversation.lastSeq', 4)
            ->has('messages', 4)
            ->where('messages.0.seq', 1)
            ->where('messages.0.sender.type', 'visitor')
            ->where('messages.0.clientMsgId', '01JTESTCLIENTMSG000000000A')
            ->where('messages.1.sender.type', 'agent')
            ->where('messages.1.sender.id', $agent->id)
            ->where('messages.2.type', 'system')
            ->where('messages.3.type', 'image')
            ->has('messages.3.attachments', 1)
            ->has('queue')
            ->has('mine', 1)
            ->has('presence.status')
            ->has('categories')
            ->etc());
    }

    public function test_the_transcript_never_leaks_file_paths_or_hashes(): void
    {
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->active($agent)->create();
        Message::factory()->for($conversation)->image()->create();

        $payload = json_encode($this->actingAs($agent)->get('/inbox/'.$conversation->ulid)->viewData('page')['props']['messages'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);

        $this->assertStringNotContainsString('sha256', $payload);
        $this->assertStringNotContainsString('original_name', $payload);
        $this->assertStringNotContainsString('"path"', $payload);
        $this->assertStringContainsString('files.test/attachments/', $payload);
    }

    public function test_an_agent_that_is_not_on_the_chat_gets_forbidden(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->agent()->create();

        $theirs = Conversation::factory()->active($colleague)->create();
        $closedTheirs = Conversation::factory()->closed($colleague)->create();
        $unofferedQueue = Conversation::factory()->create();
        $expired = Conversation::factory()->create();
        ConversationOffer::factory()->expired()->create(['conversation_id' => $expired->id, 'user_id' => $agent->id]);
        $answered = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $answered->id, 'user_id' => $colleague->id]);

        foreach ([$theirs, $closedTheirs, $unofferedQueue, $expired, $answered] as $conversation) {
            $this->actingAs($agent)->get('/inbox/'.$conversation->ulid)->assertForbidden();
        }
    }

    public function test_a_queued_chat_can_be_opened_by_the_agent_it_was_offered_to(): void
    {
        $agent = User::factory()->agent()->create();
        $conversation = Conversation::factory()->create();
        ConversationOffer::factory()->create(['conversation_id' => $conversation->id, 'user_id' => $agent->id]);

        $this->actingAs($agent)->get('/inbox/'.$conversation->ulid)->assertOk()
            ->assertInertia(fn (Assert $page) => $page->where('conversation.status', 'queued')->has('messages', 0)->etc());
    }

    public function test_an_admin_opens_any_conversation_and_an_unknown_one_is_not_found(): void
    {
        $admin = User::factory()->admin()->create();
        $closed = Conversation::factory()->closed()->create();
        $missed = Conversation::factory()->missed()->create();

        $this->actingAs($admin)->get('/inbox/'.$closed->ulid)->assertOk();
        $this->actingAs($admin)->get('/inbox/'.$missed->ulid)->assertOk();
        $this->actingAs($admin)->get('/inbox/01JNOPE0000000000000000000')->assertNotFound();
        $this->actingAs($admin)->get('/inbox/not-a-ulid')->assertNotFound();
    }

    public function test_an_inactive_or_roleless_account_cannot_open_a_conversation(): void
    {
        $conversation = Conversation::factory()->create();

        $this->actingAs(User::factory()->withoutChatAccess()->create())->get('/inbox/'.$conversation->ulid)->assertRedirect(route('login'));
        $this->actingAs(User::factory()->admin()->inactive()->create())->get('/inbox/'.$conversation->ulid)->assertRedirect(route('login'));
    }

    public function test_the_page_does_not_issue_a_query_per_row(): void
    {
        $agent = User::factory()->agent()->create();
        Conversation::factory()->count(5)->active($agent)->create();

        $this->actingAs($agent)->get('/inbox');
        $baseline = $this->countQueries(fn () => $this->actingAs($agent)->get('/inbox'));

        Conversation::factory()->count(10)->active($agent)->create();

        $this->assertSame($baseline, $this->countQueries(fn () => $this->actingAs($agent)->get('/inbox')));
    }

    private function countQueries(callable $request): int
    {
        $count = 0;
        DB::listen(function () use (&$count): void {
            $count++;
        });

        $request();

        return $count;
    }
}
