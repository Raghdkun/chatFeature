<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The admin inbox API: filters, newest activity first with a stable cursor, chat detail, transcript pages in both directions, read and
 * archive.
 */
class WhatsAppInboxApiTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    private WhatsAppSession $session;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        Storage::fake('local');
        $this->admin = $this->whatsAppPeople()['admin'];
        $this->session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
    }

    private function api(): self
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    /**
     * @param  array<string, mixed>  $attributes
     */
    private function chat(string $lastAt, array $attributes = [], ?WhatsAppSession $session = null): WaChat
    {
        return WaChat::factory()->for($session ?? $this->session, 'session')->create($attributes + ['last_message_at' => $lastAt, 'last_message_preview' => 'at '.$lastAt]);
    }

    // ---- the list ----------------------------------------------------------------------------------------------------------

    public function test_the_list_is_newest_activity_first_with_the_documented_row_shape(): void
    {
        $old = $this->chat('2026-05-01 10:00:00', ['push_name' => 'Old']);
        $new = $this->chat('2026-05-03 10:00:00', ['push_name' => 'New', 'unread_by_admin' => 2, 'inbound_initiated' => true]);

        $response = $this->api()->getJson('/api/v1/whatsapp/chats')->assertOk();

        $this->assertSame([$new->ulid, $old->ulid], array_column($response->json('data'), 'ulid'));
        $row = $response->json('data.0');
        $this->assertSame(['ulid', 'session', 'phone', 'pushName', 'isGroup', 'status', 'linked', 'widget', 'category', 'unreadByAdmin', 'inboundInitiated', 'lastInboundAt', 'lastMessageAt', 'lastMessagePreview', 'createdAt'], array_keys($row));
        $this->assertSame(['ulid' => $this->session->ulid, 'name' => 'support-main'], $row['session']);
        $this->assertSame(2, $row['unreadByAdmin']);
        $this->assertNull($response->json('meta.next_cursor'));
        $this->assertSame(1, $response->json('meta.unread_chats'));
        $this->assertStringNotContainsString('@c.us', $response->getContent(), 'no WhatsApp chat id leaves the server');
    }

    public function test_a_chat_without_a_message_is_ordered_by_its_creation(): void
    {
        $quiet = WaChat::factory()->for($this->session, 'session')->create(['last_message_at' => null, 'created_at' => '2026-05-02 10:00:00']);
        $old = $this->chat('2026-05-01 10:00:00');
        $new = $this->chat('2026-05-03 10:00:00');

        $ids = array_column($this->api()->getJson('/api/v1/whatsapp/chats')->json('data'), 'ulid');

        $this->assertSame([$new->ulid, $quiet->ulid, $old->ulid], $ids);
    }

    public function test_the_cursor_walks_the_whole_inbox_without_a_gap_or_a_repeat_even_with_equal_times(): void
    {
        $expected = [];

        foreach (range(1, 7) as $index) {
            $expected[] = $this->chat($index <= 3 ? '2026-05-01 10:00:00' : '2026-05-0'.$index.' 10:00:00')->ulid;
        }

        $collected = [];
        $cursor = null;

        do {
            $url = '/api/v1/whatsapp/chats?limit=3'.($cursor === null ? '' : '&cursor='.urlencode($cursor));
            $page = $this->api()->getJson($url)->assertOk();
            array_push($collected, ...array_column($page->json('data'), 'ulid'));
            $cursor = $page->json('meta.next_cursor');
        } while ($cursor !== null);

        $this->assertCount(7, $collected);
        $this->assertSame($collected, array_values(array_unique($collected)), 'no repeats');
        $this->assertEqualsCanonicalizing($expected, $collected, 'no gaps');
    }

    public function test_a_chat_that_moves_up_between_pages_is_not_lost(): void
    {
        $chats = collect(range(1, 5))->map(fn (int $day): WaChat => $this->chat('2026-05-0'.$day.' 10:00:00'));

        $first = $this->api()->getJson('/api/v1/whatsapp/chats?limit=2')->assertOk();
        $this->assertSame([$chats[4]->ulid, $chats[3]->ulid], array_column($first->json('data'), 'ulid'));

        // The oldest chat gets a message after page one was read: it moves to the top, which page one already passed.
        $chats[0]->update(['last_message_at' => '2026-06-01 10:00:00']);
        $second = $this->api()->getJson('/api/v1/whatsapp/chats?limit=2&cursor='.urlencode($first->json('meta.next_cursor')))->assertOk();

        $this->assertSame([$chats[2]->ulid, $chats[1]->ulid], array_column($second->json('data'), 'ulid'));
    }

    public function test_a_cursor_that_is_not_ours_is_a_422(): void
    {
        foreach (['garbage', base64_encode('{"a":1}'), base64_encode('{"t":"x","i":1}'), str_repeat('a', 300)] as $cursor) {
            $this->api()->getJson('/api/v1/whatsapp/chats?cursor='.urlencode($cursor))->assertStatus(422)->assertJsonValidationErrors('cursor', 'error.details');
        }
    }

    public function test_filters_narrow_the_list(): void
    {
        $widget = Widget::factory()->create();
        $category = Category::factory()->create(['slug' => 'billing']);
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => 'Vera Visitor', 'email' => 'vera@example.test']);
        $linked = $this->chat('2026-05-03 10:00:00', ['widget_id' => $widget->id, 'category_id' => $category->id, 'visitor_id' => $visitor->id]);
        $unlinked = $this->chat('2026-05-02 10:00:00', ['unread_by_admin' => 3]);
        $archived = $this->chat('2026-05-01 10:00:00', ['status' => WaChatStatus::Archived]);
        $otherSession = WhatsAppSession::factory()->ready()->create();
        $elsewhere = $this->chat('2026-05-04 10:00:00', session: $otherSession);

        $ulids = fn (string $query): array => array_column($this->api()->getJson('/api/v1/whatsapp/chats'.$query)->assertOk()->json('data'), 'ulid');

        $this->assertSame([$elsewhere->ulid, $linked->ulid, $unlinked->ulid], $ulids(''), 'open chats by default');
        $this->assertSame([$archived->ulid], $ulids('?status=archived'));
        $this->assertCount(4, $ulids('?status=all'));
        $this->assertSame([$linked->ulid], $ulids('?linked=1'));
        $this->assertSame([$elsewhere->ulid, $unlinked->ulid], $ulids('?linked=0'));
        $this->assertSame([$linked->ulid], $ulids('?widget='.$widget->ulid));
        $this->assertSame([$linked->ulid], $ulids('?category=billing'));
        $this->assertSame([$linked->ulid], $ulids('?category='.$category->ulid));
        $this->assertSame([$unlinked->ulid], $ulids('?unread=1'));
        $this->assertSame([$elsewhere->ulid], $ulids('?session='.$otherSession->ulid));
        $this->assertSame([$linked->ulid], $ulids('?q=vera%40example.test'), 'the search reaches the linked visitor');
    }

    public function test_the_search_finds_message_text_and_numbers_and_treats_wildcards_literally(): void
    {
        $match = $this->chat('2026-05-02 10:00:00', ['phone_e164' => '+4915123456789']);
        WaMessage::factory()->for($match, 'chat')->inbound()->create(['body' => 'Where is my refund for invoice 4711?']);
        $other = $this->chat('2026-05-01 10:00:00', ['phone_e164' => '+4917600000000']);
        WaMessage::factory()->for($other, 'chat')->inbound()->create(['body' => 'Hello there']);

        $ulids = fn (string $query): array => array_column($this->api()->getJson('/api/v1/whatsapp/chats?q='.urlencode($query))->assertOk()->json('data'), 'ulid');

        $this->assertSame([$match->ulid], $ulids('refund'));
        $this->assertSame([$match->ulid], $ulids('4711'));
        $this->assertSame([$match->ulid], $ulids('49 151 23456789'));
        $this->assertSame([], $ulids('%'));
        $this->assertSame([], $ulids('_'));
    }

    public function test_the_list_of_a_deleted_sessions_chats_is_still_there_and_names_the_session(): void
    {
        $gone = WhatsAppSession::factory()->ready()->create(['name' => 'old-number']);
        $chat = $this->chat('2026-05-01 10:00:00', session: $gone);
        $gone->delete();

        $row = $this->api()->getJson('/api/v1/whatsapp/chats')->assertOk()->json('data.0');

        $this->assertSame($chat->ulid, $row['ulid']);
        $this->assertSame('old-number', $row['session']['name']);
    }

    public function test_bad_filters_are_422s(): void
    {
        foreach (['?status=deleted', '?session=x', '?widget=x', '?limit=0', '?limit=101', '?linked=maybe', '?q='.str_repeat('a', 201)] as $query) {
            $this->api()->getJson('/api/v1/whatsapp/chats'.$query)->assertStatus(422);
        }
    }

    // ---- one chat ----------------------------------------------------------------------------------------------------------

    public function test_a_chat_with_its_link_info(): void
    {
        $widget = Widget::factory()->create(['name' => 'Main site']);
        $category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => 'Vera Visitor', 'email' => 'vera@example.test', 'meta' => ['secret' => 'host-side-data']]);
        $chat = WaChat::factory()->for($this->session, 'session')->linked($widget, $visitor, $category)->create();

        $response = $this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertOk();

        $response->assertJsonPath('data.chat.ulid', $chat->ulid)
            ->assertJsonPath('data.chat.linked', true)
            ->assertJsonPath('data.chat.widget.name', 'Main site')
            ->assertJsonPath('data.chat.category.slug', 'billing')
            ->assertJsonPath('data.visitor.name', 'Vera Visitor')
            ->assertJsonPath('data.visitor.email', 'vera@example.test')
            ->assertJsonPath('data.handoff.code', $chat->handoffTicket->code);
        $this->assertStringNotContainsString('host-side-data', $response->getContent(), 'the visitor\'s host-side meta is not shown');
    }

    public function test_an_unlinked_chat_has_no_visitor_or_hand_off(): void
    {
        $chat = $this->chat('2026-05-01 10:00:00');

        $this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid)->assertOk()->assertJsonPath('data.visitor', null)->assertJsonPath('data.handoff', null)->assertJsonPath('data.chat.linked', false);
    }

    public function test_an_unknown_chat_is_404(): void
    {
        $this->api()->getJson('/api/v1/whatsapp/chats/01J9ZZZZZZZZZZZZZZZZZZZZZZ')->assertNotFound();
        $this->api()->getJson('/api/v1/whatsapp/chats/not-a-ulid')->assertNotFound();
        $this->api()->postJson('/api/v1/whatsapp/chats/01J9ZZZZZZZZZZZZZZZZZZZZZZ/read')->assertNotFound();
    }

    // ---- the transcript ----------------------------------------------------------------------------------------------------

    /**
     * @return array{0: WaChat, 1: list<WaMessage>}
     */
    private function transcript(int $count): array
    {
        $chat = $this->chat('2026-05-01 10:00:00');
        $messages = [];

        foreach (range(1, $count) as $index) {
            $messages[] = WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => 'message '.$index, 'wa_timestamp' => now()->subMinutes($count - $index)]);
        }

        return [$chat, $messages];
    }

    public function test_the_newest_page_comes_first_by_default_oldest_first_inside_the_page(): void
    {
        [$chat, $messages] = $this->transcript(7);

        $response = $this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages?limit=3')->assertOk();

        $this->assertSame(['message 5', 'message 6', 'message 7'], array_column($response->json('data'), 'body'));
        $this->assertNull($response->json('meta.next_cursor'));
        $this->assertSame($messages[4]->ulid, $response->json('meta.prev_cursor'));
    }

    public function test_before_id_walks_back_through_the_history(): void
    {
        [$chat] = $this->transcript(7);
        $url = '/api/v1/whatsapp/chats/'.$chat->ulid.'/messages?limit=3';
        $bodies = [];

        $page = $this->api()->getJson($url)->assertOk();
        array_unshift($bodies, ...array_column($page->json('data'), 'body'));

        while (($prev = $page->json('meta.prev_cursor')) !== null) {
            $page = $this->api()->getJson($url.'&before_id='.$prev)->assertOk();
            $this->assertNotNull($page->json('meta.next_cursor'), 'there is always something after a page that was read backwards');
            array_unshift($bodies, ...array_column($page->json('data'), 'body'));
        }

        $this->assertSame(array_map(fn (int $i): string => 'message '.$i, range(1, 7)), $bodies);
    }

    public function test_after_id_is_the_sync_call_after_a_reconnect(): void
    {
        [$chat, $messages] = $this->transcript(7);
        $url = '/api/v1/whatsapp/chats/'.$chat->ulid.'/messages?limit=3&after_id=';

        $one = $this->api()->getJson($url.$messages[1]->ulid)->assertOk();
        $this->assertSame(['message 3', 'message 4', 'message 5'], array_column($one->json('data'), 'body'));
        $this->assertSame($messages[4]->ulid, $one->json('meta.next_cursor'));
        $this->assertSame($messages[2]->ulid, $one->json('meta.prev_cursor'));

        $two = $this->api()->getJson($url.$one->json('meta.next_cursor'))->assertOk();
        $this->assertSame(['message 6', 'message 7'], array_column($two->json('data'), 'body'));
        $this->assertNull($two->json('meta.next_cursor'));

        $none = $this->api()->getJson($url.$messages[6]->ulid)->assertOk();
        $this->assertSame([], $none->json('data'));
        $this->assertNull($none->json('meta.next_cursor'));
        $this->assertNull($none->json('meta.prev_cursor'));
    }

    public function test_a_cursor_from_another_chat_or_an_unknown_one_is_a_422(): void
    {
        [$chat] = $this->transcript(2);
        [, $foreign] = $this->transcript(1);
        $base = '/api/v1/whatsapp/chats/'.$chat->ulid.'/messages';

        $this->api()->getJson($base.'?after_id='.$foreign[0]->ulid)->assertStatus(422)->assertJsonValidationErrors('after_id', 'error.details');
        $this->api()->getJson($base.'?before_id='.$foreign[0]->ulid)->assertStatus(422)->assertJsonValidationErrors('before_id', 'error.details');
        $this->api()->getJson($base.'?after_id=01J9ZZZZZZZZZZZZZZZZZZZZZZ')->assertStatus(422);
        $this->api()->getJson($base.'?after_id=nope')->assertStatus(422);
        $this->api()->getJson($base.'?limit=201')->assertStatus(422);
        $this->api()->getJson($base.'?after_id='.$foreign[0]->ulid.'&before_id='.$foreign[0]->ulid)->assertStatus(422);
    }

    public function test_a_message_never_shows_the_whatsapp_id_the_raw_object_or_the_storage_path(): void
    {
        $chat = $this->chat('2026-05-01 10:00:00');
        WaMessage::factory()->for($chat, 'chat')->inbound()->image('a caption')->create(['raw' => ['secret' => 'raw-object-content']]);

        $response = $this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages')->assertOk();
        $body = $response->getContent();

        $this->assertStringNotContainsString('raw-object-content', $body);
        $this->assertStringNotContainsString('whatsapp/media/', $body);
        $this->assertStringNotContainsString('false_', $body, 'no WhatsApp message id');
        $this->assertStringStartsWith('https://files.test/whatsapp/', $response->json('data.0.media.url'), 'the image is a signed URL');
    }

    // ---- read / archive ----------------------------------------------------------------------------------------------------

    public function test_mark_read_zeroes_the_counter_announces_it_once_and_is_idempotent(): void
    {
        $chat = $this->chat('2026-05-01 10:00:00', ['unread_by_admin' => 4]);
        Event::fake([WaChatUpdated::class]);

        $this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/read')->assertOk()->assertJsonPath('data.unreadByAdmin', 0);
        $this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/read')->assertOk()->assertJsonPath('data.unreadByAdmin', 0);

        Event::assertDispatchedTimes(WaChatUpdated::class, 1);
        $this->assertSame(0, $chat->refresh()->unread_by_admin);
    }

    public function test_archive_and_unarchive_are_guarded_audited_and_announced(): void
    {
        $chat = $this->chat('2026-05-01 10:00:00');
        Event::fake([WaChatUpdated::class]);

        $this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/archive')->assertOk()->assertJsonPath('data.status', 'archived');
        $this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/archive')->assertOk()->assertJsonPath('data.status', 'archived');
        $this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/unarchive')->assertOk()->assertJsonPath('data.status', 'open');

        Event::assertDispatchedTimes(WaChatUpdated::class, 2);
        $this->assertSame(['whatsapp.chat.archived', 'whatsapp.chat.unarchived'], AuditLog::query()->whereIn('action', ['whatsapp.chat.archived', 'whatsapp.chat.unarchived'])->orderBy('id')->pluck('action')->all());
    }
}
