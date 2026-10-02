<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Models\AuditLog;
use App\Models\Category;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\InteractsWithWhatsAppWidgets;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The whole feature in one story, through the real routes with a faked OpenWA: set up the connection, add and start a number, scan, link a
 * widget, hand a visitor over, receive the first message with the code (linked), reply, follow the ticks, archive and be re-opened by the
 * customer; and an agent sees none of it.
 */
class WhatsAppFullFlowTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, InteractsWithWhatsAppWidgets, OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures;

    public function test_from_setup_to_a_delivered_and_read_reply(): void
    {
        Storage::fake('local');
        $broadcaster = $this->recordBroadcasts();
        $this->useFortifyMode();
        config(['chat.portal_allow_private_hosts' => true]);
        settings()->set('whatsapp.send_min_interval_ms', 0);
        $people = $this->whatsAppPeople();
        $admin = $people['admin'];
        $api = fn () => $this->actingAs($admin, 'sanctum');
        $openWa = $this->openWa();

        // 1. Settings: the address, the key, the switch.
        $api()->putJson('/api/v1/whatsapp/settings', ['enabled' => true, 'api_key' => 'owa_k1_the-flow-key-0123456789'])->assertOk()->assertJsonPath('data.hasApiKey', true);
        $api()->postJson('/api/v1/whatsapp/settings/test')->assertOk()->assertJsonPath('data.ok', true)->assertJsonPath('data.canOperate', true);

        // 2. A number: created at OpenWA, then started; the webhook is registered once with the app's own secret.
        $created = $api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main'])->assertCreated()->assertJsonPath('data.status', 'created');
        $session = WhatsAppSession::query()->where('ulid', $created->json('data.ulid'))->sole();
        $api()->postJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/start')->assertStatus(202)->assertJsonPath('data.webhookRegistered', true);
        $session->refresh();
        $this->assertSame(SessionStatus::Starting, $session->status);
        $openWa->assertCalled('registerWebhook', fn (array $args): bool => $args['secret'] === $session->webhook_secret && $args['url'] === $session->webhookUrl(), 1);

        // 3. OpenWA tells the app about the QR and the scan, by signed webhook.
        $this->deliver($session, $this->envelope('session.status', ['status' => 'qr_ready']))->assertOk();
        $this->deliver($session, $this->envelope('session.qr', ['qr' => WhatsAppSessionFactory::FAKE_QR]))->assertOk();
        $this->assertSame(SessionStatus::Qr, $session->refresh()->status);
        $api()->getJson('/api/v1/whatsapp/sessions/'.$session->ulid.'/qr')->assertOk()->assertJsonPath('data.qr', WhatsAppSessionFactory::FAKE_QR);
        $this->deliver($session, $this->envelope('session.authenticated', ['phone' => '4915123456789', 'pushName' => 'PNE Support']))->assertOk();
        $session->refresh();
        $this->assertSame(SessionStatus::Ready, $session->status);
        $this->assertNull($session->last_qr, 'the QR is gone once it was scanned');
        $statuses = array_column(array_column($broadcaster->of('wa.session.status'), 'payload'), 'session');
        $this->assertSame('ready', end($statuses)['status'], 'the page was told, every step of the way');

        // 4. The widget hands visitors over to it.
        [$widget, $category] = $this->chatWidget();
        $this->publishWhatsAppFeature($widget);
        $api()->putJson('/api/v1/widgets/'.$widget->ulid.'/whatsapp', ['session' => $session->ulid])->assertOk()->assertJsonPath('data.connected', true);
        $availability = $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/'.$widget->public_key.'/availability')->assertOk();
        $this->assertSame(['enabled' => true], $availability->json('data.whatsapp'));

        // 5. A visitor picks WhatsApp and gets a code and a link.
        $visitor = $this->visitorSession($widget, ['name' => 'Vera Visitor', 'email' => 'vera@example.test']);
        $handoff = $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$visitor->plaintext])
            ->postJson('/api/v1/public/widgets/'.$widget->public_key.'/whatsapp-handoff', ['category' => 'billing'])->assertCreated();
        $code = (string) $handoff->json('data.code');
        $this->assertStringStartsWith('https://wa.me/4915123456789?text=', $handoff->json('data.waUrl'));

        // 6. The customer sends the first message from their phone: the chat is recorded and linked.
        $broadcaster->reset();
        $this->deliver($session, $this->messageReceived(['body' => 'Hi! My support code is '.$code, 'contact' => ['pushName' => 'Vera']]))->assertOk();
        $chat = WaChat::query()->sole();
        $this->assertSame($widget->id, $chat->widget_id);
        $this->assertSame($visitor->session->visitor_id, $chat->visitor_id);
        $this->assertSame(Category::query()->where('slug', 'billing')->value('id'), $chat->category_id);
        $this->assertTrue($broadcaster->sole('wa.message.created')['payload']['chat']['linked']);

        $list = $api()->getJson('/api/v1/whatsapp/chats')->assertOk();
        $this->assertSame($chat->ulid, $list->json('data.0.ulid'));
        $this->assertSame(1, $list->json('data.0.unreadByAdmin'));
        $this->assertSame('Vera Visitor', $api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid)->json('data.visitor.name'));

        // 7. An administrator reads it and replies; the send job hands it to OpenWA.
        $api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/read')->assertOk()->assertJsonPath('data.unreadByAdmin', 0);
        $reply = $api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'Hi Vera, I am looking at it now.', 'client_msg_id' => strtolower((string) Str::ulid())])
            ->assertCreated()->assertJsonPath('data.status', 'sent');
        $openWa->assertCalled('sendText', fn (array $args): bool => $args['chatId'] === '4915123456789@c.us' && $args['text'] === 'Hi Vera, I am looking at it now.', 1);
        $replyRow = WaMessage::query()->where('ulid', $reply->json('data.ulid'))->sole();
        $waId = (string) $replyRow->wa_message_id;

        // 8. The ticks arrive (out of order and twice), and the transcript shows them.
        $this->deliver($session, $this->messageAck($waId, 'read'))->assertOk();
        $this->deliver($session, $this->messageAck($waId, 'delivered'))->assertOk();
        $this->deliver($session, $this->messageAck($waId, 'read'))->assertOk();
        $this->assertSame(WaMessageStatus::Read, $replyRow->refresh()->status);
        $transcript = $api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages')->assertOk();
        $this->assertSame(['in', 'out'], array_column($transcript->json('data'), 'direction'));
        $this->assertSame(['received', 'read'], array_column($transcript->json('data'), 'status'));

        // 9. Put away, then the customer writes again: the chat is back.
        $api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/archive')->assertOk();
        $this->assertSame([], $api()->getJson('/api/v1/whatsapp/chats')->json('data'));
        $this->deliver($session, $this->messageReceived(['body' => 'One more thing']))->assertOk();
        $again = $api()->getJson('/api/v1/whatsapp/chats')->assertOk();
        $this->assertSame($chat->ulid, $again->json('data.0.ulid'));
        $this->assertSame(1, $again->json('data.0.unreadByAdmin'));

        // 10. An agent sees none of it; the trail is in the audit log.
        $agent = $people['agent'];
        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/whatsapp/chats')->assertForbidden();
        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/conversations?q=looking')->assertOk()->assertJsonPath('data', []);
        $actions = AuditLog::query()->pluck('action')->all();
        foreach (['whatsapp.settings.updated', 'whatsapp.session.created', 'whatsapp.session.started', 'widget.whatsapp_linked', 'whatsapp.message.sent', 'whatsapp.chat.archived'] as $expected) {
            $this->assertContains($expected, $actions);
        }

        $this->assertInstanceOf(User::class, $agent);
    }
}
