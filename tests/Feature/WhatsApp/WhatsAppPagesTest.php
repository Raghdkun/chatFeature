<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Settings\SettingsRepository;
use App\Models\Category;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The three WhatsApp pages (`/whatsapp`, `/whatsapp/{chat}`, `/settings/whatsapp`): administrators only (decision P6-D1), the props of
 * `resources/js/types/whatsapp.ts`, and no secret in any of them.
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

    /**
     * @return array<string, array{string}>
     */
    public static function pages(): array
    {
        return ['inbox' => ['inbox'], 'chat' => ['chat'], 'settings' => ['settings']];
    }

    private function url(string $page, ?WaChat $chat = null): string
    {
        return match ($page) {
            'inbox' => '/whatsapp',
            'chat' => '/whatsapp/'.($chat ?? WaChat::factory()->create())->ulid,
            default => '/settings/whatsapp',
        };
    }

    #[DataProvider('pages')]
    public function test_a_guest_is_sent_to_the_sign_in_page(string $page): void
    {
        $this->get($this->url($page))->assertRedirect(route('login'));
    }

    #[DataProvider('pages')]
    public function test_an_agent_gets_403_and_is_told_nothing_about_the_chats(string $page): void
    {
        $chat = WaChat::factory()->create(['push_name' => 'Secret Customer', 'last_message_preview' => 'secret preview']);
        $agent = $this->whatsAppPeople()['agent'];

        $response = $this->actingAs($agent)->get($this->url($page, $chat))->assertForbidden();

        $response->assertDontSee('Secret Customer')->assertDontSee('secret preview')->assertDontSee($chat->ulid);
    }

    #[DataProvider('pages')]
    public function test_accounts_without_a_chat_role_or_deactivated_are_turned_away(string $page): void
    {
        $people = $this->whatsAppPeople();

        $this->actingAs($people['noRole'])->get($this->url($page))->assertRedirect(route('login'));
        $this->actingAs($people['inactiveAdmin'])->get($this->url($page))->assertRedirect(route('login'));
        $this->actingAs($people['inactiveAgent'])->get($this->url($page))->assertRedirect(route('login'));
    }

    #[DataProvider('pages')]
    public function test_an_administrator_with_or_without_the_agent_role_may_open_them(string $page): void
    {
        $chat = WaChat::factory()->create();
        $people = $this->whatsAppPeople();

        $this->actingAs($people['admin'])->get($this->url($page, $chat))->assertOk();
        $this->actingAs($people['adminAndAgent'])->get($this->url($page, $chat))->assertOk();
    }

    public function test_the_inbox_starts_with_the_open_chats_newest_first_and_the_sessions(): void
    {
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $old = WaChat::factory()->for($session, 'session')->create(['last_message_at' => now()->subHours(2), 'push_name' => 'Old']);
        $new = WaChat::factory()->for($session, 'session')->unread(3)->create(['last_message_at' => now()->subMinute(), 'push_name' => 'New']);
        WaChat::factory()->for($session, 'session')->archived()->create(['push_name' => 'Archived']);
        $admin = $this->whatsAppPeople()['admin'];

        $this->actingAs($admin)->get('/whatsapp')->assertInertia(fn (Assert $page) => $page
            ->component('whatsapp/index')
            ->has('chats', 2)
            ->where('chats.0.ulid', $new->ulid)
            ->where('chats.0.unreadByAdmin', 3)
            ->where('chats.0.session.name', 'support-main')
            ->where('chats.1.ulid', $old->ulid)
            ->where('hasMore', false)
            ->has('sessions', 1)
            ->where('sessions.0.name', 'support-main')
            ->where('sessions.0.status', 'ready')
            ->where('replyOnlyToInbound', true)
            ->missing('detail')
            ->etc());
    }

    public function test_the_list_page_is_capped_and_says_there_is_more(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();

        WaChat::factory()->count(52)->for($session, 'session')->create(['last_message_at' => now()]);

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp')->assertInertia(fn (Assert $page) => $page
            ->has('chats', 50)
            ->where('hasMore', true)
            ->etc());
    }

    public function test_one_chat_comes_with_its_link_to_the_website_and_the_newest_messages_oldest_first(): void
    {
        $widget = Widget::factory()->create(['name' => 'Main site']);
        $category = Category::factory()->create(['name' => 'Sales']);
        $chat = WaChat::factory()->linked($widget, null, $category)->create(['push_name' => 'Vera']);
        $first = WaMessage::factory()->for($chat, 'chat')->create(['body' => 'Hello', 'wa_timestamp' => now()->subMinutes(5)]);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound($this->whatsAppPeople()['admin'])->create(['body' => 'Hi Vera', 'wa_timestamp' => now()->subMinutes(4)]);
        $image = WaMessage::factory()->for($chat, 'chat')->image('A photo')->create(['wa_timestamp' => now()->subMinute()]);

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp/'.$chat->ulid)->assertInertia(fn (Assert $page) => $page
            ->component('whatsapp/show')
            ->where('detail.chat.ulid', $chat->ulid)
            ->where('detail.chat.linked', true)
            ->where('detail.chat.widget.name', 'Main site')
            ->where('detail.chat.category.label', 'Sales')
            ->has('detail.handoff.code')
            ->has('messages', 3)
            ->where('messages.0.ulid', $first->ulid)
            ->where('messages.1.ulid', $reply->ulid)
            ->where('messages.1.direction', 'out')
            ->where('messages.2.ulid', $image->ulid)
            ->where('hasOlder', false)
            ->has('chats')
            ->has('sessions')
            ->etc());
    }

    public function test_a_long_transcript_is_cut_to_the_newest_page_and_says_there_is_older_history(): void
    {
        $chat = WaChat::factory()->create();

        foreach (range(1, 103) as $n) {
            WaMessage::factory()->for($chat, 'chat')->create(['body' => "m{$n}", 'wa_timestamp' => now()->subMinutes(200 - $n)]);
        }

        $this->actingAs($this->whatsAppPeople()['admin'])->get('/whatsapp/'.$chat->ulid)->assertInertia(fn (Assert $page) => $page
            ->has('messages', 100)
            ->where('messages.0.body', 'm4')
            ->where('messages.99.body', 'm103')
            ->where('hasOlder', true)
            ->etc());
    }

    public function test_an_unknown_or_malformed_chat_is_a_404_for_an_administrator(): void
    {
        $admin = $this->whatsAppPeople()['admin'];

        $this->actingAs($admin)->get('/whatsapp/01JNOSUCHCHATNOSUCHCHAT00')->assertNotFound();
        $this->actingAs($admin)->get('/whatsapp/not-a-ulid')->assertNotFound();
    }

    public function test_the_settings_page_names_the_values_and_never_the_api_key(): void
    {
        $settings = app(SettingsRepository::class);

        $settings->set('whatsapp.openwa.api_key', 'super-secret-openwa-key');
        $settings->set('whatsapp.daily_send_cap', 75);
        $settings->set('whatsapp.reply_only_to_inbound', false);
        WhatsAppSession::factory()->qr()->create(['name' => 'sales-line']);

        $response = $this->actingAs($this->whatsAppPeople()['admin'])->get('/settings/whatsapp');

        $response->assertInertia(fn (Assert $page) => $page
            ->component('settings/whatsapp')
            ->where('settings.hasApiKey', true)
            ->where('settings.dailySendCap', 75)
            ->where('settings.replyOnlyToInbound', false)
            ->where('settings.handoffText', 'Hi! My support code is :code')
            ->where('settings.baseUrl', 'http://127.0.0.1:2785')
            ->missing('settings.apiKey')
            ->has('sessions', 1)
            ->where('sessions.0.name', 'sales-line')
            ->where('sessions.0.status', 'qr')
            ->etc());
        $response->assertDontSee('super-secret-openwa-key');
    }

    public function test_the_settings_page_says_when_no_key_is_saved(): void
    {
        $this->actingAs($this->whatsAppPeople()['admin'])->get('/settings/whatsapp')->assertInertia(fn (Assert $page) => $page
            ->where('settings.hasApiKey', false)
            ->has('sessions', 0)
            ->etc());
    }

    public function test_no_page_leaks_a_session_secret_or_the_qr_image(): void
    {
        WhatsAppSession::factory()->qr()->withWebhook('a-very-secret-webhook-secret')->create();
        $admin = $this->whatsAppPeople()['admin'];

        foreach (['/settings/whatsapp', '/whatsapp'] as $url) {
            $this->actingAs($admin)->get($url)
                ->assertDontSee('a-very-secret-webhook-secret')
                ->assertDontSee('data:image/png;base64');
        }

    }

    public function test_the_pages_are_reachable_by_name(): void
    {
        $this->assertSame(url('/whatsapp'), route('whatsapp.index'));
        $this->assertSame(url('/settings/whatsapp'), route('settings.whatsapp.edit'));
        $this->assertSame(url('/whatsapp/01ABC'), route('whatsapp.show', ['chat' => '01ABC']));
    }
}
