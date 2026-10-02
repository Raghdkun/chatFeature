<?php

namespace Tests\Feature\WhatsApp;

use App\Models\Category;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The WhatsApp Inertia pages: administrators only (a plain 403 page for everybody else), props are the documented Data classes, and no
 * secret or WhatsApp-internal id is among them.
 */
class WhatsAppPagesTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_the_inbox_page_props(): void
    {
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $chat = WaChat::factory()->for($session, 'session')->create(['last_message_at' => now(), 'unread_by_admin' => 2]);
        Widget::factory()->create(['name' => 'Main site']);
        Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        settings()->set('whatsapp.enabled', true);

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('whatsapp/inbox')
            ->where('selected', null)
            ->where('whatsappEnabled', true)
            ->has('sessions', 1, fn (Assert $row) => $row->where('name', 'support-main')->where('status', 'ready')->etc())
            ->has('chats', 1, fn (Assert $row) => $row->where('ulid', $chat->ulid)->where('unreadByAdmin', 2)->etc())
            ->where('meta.next_cursor', null)
            ->where('meta.unread_chats', 1)
            ->has('widgets', 1, fn (Assert $row) => $row->where('name', 'Main site')->etc())
            ->has('categories', 1, fn (Assert $row) => $row->where('slug', 'billing')->where('label', 'Billing')));
    }

    public function test_the_first_page_of_the_inbox_is_bounded_and_carries_a_cursor(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        WaChat::factory()->count(52)->for($session, 'session')->create(['last_message_at' => now()]);

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp')->assertInertia(fn (Assert $page) => $page
            ->has('chats', 50)
            ->whereNot('meta.next_cursor', null));
    }

    public function test_a_chat_page_carries_the_chat_its_transcript_and_the_link_info(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        $chat = WaChat::factory()->for($session, 'session')->create();
        WaMessage::factory()->count(3)->for($chat, 'chat')->inbound()->create();
        $other = WaChat::factory()->for($session, 'session')->create();

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp/chats/'.$chat->ulid)->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('whatsapp/inbox')
            ->where('selected.detail.chat.ulid', $chat->ulid)
            ->where('selected.detail.visitor', null)
            ->has('selected.messages', 3)
            ->where('selected.meta.next_cursor', null)
            ->where('selected.meta.prev_cursor', null)
            ->has('chats', 2));

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp/chats/'.$other->ulid.'x')->assertNotFound();
        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp/chats/01J9ZZZZZZZZZZZZZZZZZZZZZZ')->assertNotFound();
    }

    public function test_the_settings_page_props_never_carry_a_key_or_a_secret(): void
    {
        settings()->set('whatsapp.openwa.api_key', 'owa_k1_the-real-key-0123456789abcdef');
        $session = WhatsAppSession::factory()->ready()->withWebhook('super-secret-webhook-secret-0123456789-abcd')->create(['name' => 'support-main']);
        Widget::factory()->withWhatsAppSession($session)->create(['name' => 'Main site']);

        $response = $this->actingAs($this->whatsAppPeople()['admin'])->get('/settings/whatsapp')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('settings/whatsapp')
            ->where('settings.hasApiKey', true)
            ->where('settings.baseUrl', 'http://127.0.0.1:2785')
            ->where('privateHostsAllowed', fn ($allowed) => is_bool($allowed))
            ->has('sessions', 1)
            ->has('widgets', 1, fn (Assert $row) => $row->where('widget.name', 'Main site')->where('session.name', 'support-main')->where('connected', true)->etc()));

        $body = $response->getContent();
        $this->assertStringNotContainsString('owa_k1_the-real-key', $body);
        $this->assertStringNotContainsString('super-secret-webhook-secret', $body);
        $this->assertStringNotContainsString((string) $session->openwa_session_id, $body);
    }

    public function test_every_page_turns_agents_and_the_rest_away_without_a_trace_of_whatsapp(): void
    {
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $chat = WaChat::factory()->for($session, 'session')->create(['push_name' => 'Anna Customer']);
        $pages = ['/whatsapp', '/whatsapp/chats/'.$chat->ulid, '/settings/whatsapp'];
        $people = $this->whatsAppPeople();

        foreach ($pages as $page) {
            $this->get($page)->assertRedirect(route('login'));
        }

        foreach ($pages as $page) {
            $response = $this->actingAs($people['agent'])->get($page)->assertForbidden();
            $this->assertStringNotContainsString('Anna Customer', $response->getContent());
            $this->assertStringNotContainsString('support-main', $response->getContent());

            $this->actingAs($people['agent'])->getJson($page)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            $this->actingAs($people['adminAndAgent'])->get($page)->assertOk();
        }

        $this->assertInstanceOf(User::class, $people['noRole']);
    }
}
