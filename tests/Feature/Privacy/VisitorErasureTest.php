<?php

namespace Tests\Feature\Privacy;

use App\Domain\Chat\Realtime\Sockets\SocketTags;
use App\Models\Attachment;
use App\Models\AuditLog;
use App\Models\Conversation;
use App\Models\ConversationEvent;
use App\Models\ConversationOffer;
use App\Models\Message;
use App\Models\Rating;
use App\Models\RealtimeGrant;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\PrivacyWorld;
use Tests\TestCase;

/**
 * `DELETE /api/v1/visitors/{ulid}` and `chat:erase-visitor`: one visitor's identity, sessions, conversations, messages, attachment files and
 * offline tickets are gone, nobody else's are touched, the call is idempotent, audited without personal data, and administrators only.
 */
class VisitorErasureTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, PrivacyWorld, RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->useRealtime();
        Storage::fake('local');
        $this->admin = User::factory()->admin()->create();
    }

    private function erase(string $ulid, ?User $as = null)
    {
        $this->app['auth']->forgetGuards();

        return $this->actingAs($as ?? $this->admin, 'sanctum')->deleteJson('/api/v1/visitors/'.$ulid);
    }

    public function test_an_administrator_erases_one_visitor_and_only_that_visitor(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category, ['name' => 'Jane Doe', 'email' => 'jane@example.test', 'phone' => '+49 30 111', 'external_id' => 'cust-1', 'verified' => true]);
        $john = $this->visitorWithHistory($widget, $category, ['name' => 'John Roe', 'email' => 'john@example.test']);
        $chat = WaChat::factory()->create(['visitor_id' => $jane['visitor']->id, 'widget_id' => $widget->id]);
        WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'visitor_id' => $jane['visitor']->id]);

        $response = $this->erase($jane['visitor']->ulid)->assertOk();

        $response->assertJsonPath('data.visitor', $jane['visitor']->ulid)->assertJsonPath('data.erased', true);
        $this->assertSame(1, $response->json('data.sessions'));
        $this->assertSame(3, $response->json('data.conversations'));
        $this->assertSame(1, $response->json('data.offlineTickets'));
        $this->assertSame(7, $response->json('data.messages'));
        $this->assertSame(2, $response->json('data.attachments'));
        $this->assertSame(2, $response->json('data.ratings'));

        // Jane is gone, with everything that hung on her.
        $this->assertNull(Visitor::query()->find($jane['visitor']->id));
        $this->assertSame(0, VisitorSession::query()->where('visitor_id', $jane['visitor']->id)->count());
        $this->assertSame([], Conversation::query()->whereIn('id', collect($jane['conversations'])->pluck('id'))->pluck('id')->all());
        $this->assertSame(0, Message::query()->where('body', 'like', '%'.$jane['visitor']->ulid.'%')->count());
        $this->assertSame(0, Attachment::query()->where('original_name', 'like', '%'.$jane['visitor']->ulid.'%')->count());
        $this->assertSame(0, Rating::query()->where('comment', 'like', '%'.$jane['visitor']->ulid.'%')->count());
        $this->assertSame(0, ConversationEvent::query()->where('actor_id', $jane['visitor']->id)->where('actor_type', 'visitor')->count());
        $this->assertSame(0, WaHandoffTicket::query()->where('visitor_id', $jane['visitor']->id)->count());

        // The files are gone from the disk, and only hers.
        foreach ($jane['files'] as $path) {
            Storage::disk('local')->assertMissing($path);
        }

        foreach ($john['files'] as $path) {
            Storage::disk('local')->assertExists($path);
        }

        // John keeps every row, and the staff members' own records are untouched.
        $this->assertNotNull(Visitor::query()->find($john['visitor']->id));
        $this->assertSame(3, Conversation::query()->where('visitor_id', $john['visitor']->id)->count());
        $this->assertSame(7, Message::query()->whereIn('conversation_id', collect($john['conversations'])->pluck('id'))->count());
        $this->assertSame(2, Attachment::query()->whereIn('conversation_id', collect($john['conversations'])->pluck('id'))->count());
        $this->assertSame(2, RealtimeGrant::query()->count());
        $this->assertSame(2, ConversationOffer::query()->count());
        $this->assertTrue(User::query()->where('email', 'agent.smith@secret.example')->exists());

        // A linked WhatsApp chat is a separate record: it stays, unlinked.
        $this->assertNull($chat->fresh()->visitor_id);
        $this->assertNotNull(WaChat::query()->find($chat->id));

        // Her open sockets are closed.
        $this->assertTrue($this->sockets->was(SocketTags::visitorSession($jane['session']->id)));
        $this->assertFalse($this->sockets->was(SocketTags::visitorSession($john['session']->id)));
    }

    public function test_the_audit_entry_has_ids_and_counts_but_no_personal_data(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category, ['name' => 'Jane Doe', 'email' => 'jane@example.test', 'phone' => '+49 30 111']);

        $this->erase($jane['visitor']->ulid)->assertOk();

        $entry = AuditLog::query()->where('action', 'privacy.visitor.erased')->sole();
        $dump = json_encode($entry->toArray());

        $this->assertSame($this->admin->id, $entry->actor_id);
        $this->assertStringContainsString($jane['visitor']->ulid, (string) $dump);
        $this->assertSame(3, $entry->changes['conversations']);

        foreach (['Jane', 'jane@example.test', '+49 30 111', 'private words', 'receipt-of'] as $personal) {
            $this->assertStringNotContainsString($personal, (string) $dump);
        }
    }

    public function test_it_is_idempotent_and_an_unknown_visitor_is_not_an_error(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);

        $this->erase($jane['visitor']->ulid)->assertOk()->assertJsonPath('data.erased', true);
        $second = $this->erase($jane['visitor']->ulid)->assertOk();

        $second->assertJsonPath('data.erased', false);
        $this->assertSame(1, AuditLog::query()->where('action', 'privacy.visitor.erased')->count(), 'the second call changes (and records) nothing');

        foreach ([strtolower((string) Str::ulid()), 'not-a-ulid', '01HZZZZZZZZZZZZZZZZZZZZZZZ'] as $unknown) {
            $this->erase($unknown)->assertOk()->assertJsonPath('data.erased', false);
        }
    }

    public function test_a_visitor_with_a_chat_that_is_still_open_is_not_erased(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);
        Conversation::factory()->forCategory($category)->create(['widget_id' => $widget->id, 'visitor_id' => $jane['visitor']->id, 'visitor_session_id' => $jane['session']->id]);

        $this->erase($jane['visitor']->ulid)->assertStatus(409)->assertJsonPath('error.code', 'visitor_has_open_chat')->assertJsonPath('error.details.openConversations', 1);

        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));
        foreach ($jane['files'] as $path) {
            Storage::disk('local')->assertExists($path);
        }
        $this->assertSame(0, AuditLog::query()->where('action', 'privacy.visitor.erased')->count());
    }

    public function test_a_file_that_cannot_be_deleted_stops_the_erasure_before_any_row_is_removed(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);
        Storage::shouldReceive('disk')->andReturn(new class
        {
            public function delete(): bool
            {
                return false;
            }

            public function exists(): bool
            {
                return true;
            }
        });

        $this->erase($jane['visitor']->ulid)->assertStatus(500);

        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));
        $this->assertSame(3, Conversation::query()->where('visitor_id', $jane['visitor']->id)->count());
    }

    public function test_only_administrators_may_erase(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);
        $agent = User::factory()->agent()->create();
        $inactiveAdmin = User::factory()->admin()->inactive()->create();

        $this->erase($jane['visitor']->ulid, $agent)->assertForbidden();
        $this->erase($jane['visitor']->ulid, $inactiveAdmin)->assertUnauthorized();
        $this->app['auth']->forgetGuards();
        $this->deleteJson('/api/v1/visitors/'.$jane['visitor']->ulid)->assertUnauthorized();

        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));
    }

    public function test_the_visitor_token_of_the_visitor_does_not_reach_the_endpoint(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);
        $token = $this->visitorSession($widget);

        $this->withHeaders($this->bearer($token))->deleteJson('/api/v1/visitors/'.$jane['visitor']->ulid)->assertUnauthorized();
        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));
    }

    // ---- the command ----------------------------------------------------------------------------------------------------------------

    public function test_the_command_erases_by_ulid_and_by_email_and_is_idempotent(): void
    {
        [$widget, $category] = $this->chatWidget();
        $first = $this->visitorWithHistory($widget, $category, ['email' => 'same@example.test']);
        $second = $this->visitorWithHistory($widget, $category, ['email' => 'same@example.test']);
        $other = $this->visitorWithHistory($widget, $category, ['email' => 'other@example.test']);

        $this->artisan('chat:erase-visitor', ['visitor' => $first['visitor']->ulid, '--force' => true])->assertSuccessful();
        $this->assertNull(Visitor::query()->find($first['visitor']->id));
        $this->assertNotNull(Visitor::query()->find($second['visitor']->id));

        $this->artisan('chat:erase-visitor', ['--email' => 'same@example.test', '--force' => true])->assertSuccessful();
        $this->assertNull(Visitor::query()->find($second['visitor']->id));
        $this->assertNotNull(Visitor::query()->find($other['visitor']->id), 'another address is not touched');

        $this->artisan('chat:erase-visitor', ['--email' => 'same@example.test', '--force' => true])->expectsOutputToContain('Nothing to erase')->assertSuccessful();
        $this->assertSame(2, AuditLog::query()->where('action', 'privacy.visitor.erased')->count());
        $this->assertNull(AuditLog::query()->where('action', 'privacy.visitor.erased')->first()->actor_id, 'a console run has no signed-in actor');
    }

    public function test_the_command_needs_exactly_one_selector_confirms_and_reports_an_open_chat(): void
    {
        [$widget, $category] = $this->chatWidget();
        $jane = $this->visitorWithHistory($widget, $category);

        $this->artisan('chat:erase-visitor')->assertFailed();
        $this->artisan('chat:erase-visitor', ['visitor' => $jane['visitor']->ulid, '--email' => 'a@b.test'])->assertFailed();

        $this->artisan('chat:erase-visitor', ['visitor' => $jane['visitor']->ulid])->expectsConfirmation('Erase 1 visitor record(s) and everything held about them? This cannot be undone.', 'no')->assertFailed();
        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));

        Conversation::factory()->forCategory($category)->create(['widget_id' => $widget->id, 'visitor_id' => $jane['visitor']->id, 'visitor_session_id' => $jane['session']->id]);
        $this->artisan('chat:erase-visitor', ['visitor' => $jane['visitor']->ulid, '--force' => true])->assertFailed();
        $this->assertNotNull(Visitor::query()->find($jane['visitor']->id));
    }
}
