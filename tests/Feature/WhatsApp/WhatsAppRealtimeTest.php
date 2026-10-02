<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Events\WaChatLinked;
use App\Domain\WhatsApp\Events\WaChatUpdated;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Events\WaSessionQrUpdated;
use App\Domain\WhatsApp\Events\WaSessionStatusChanged;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Storage;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * The domain events reach `private-whatsapp-admin` as `wa.*` broadcasts, with the payloads of the contract, only on that channel, never with
 * the QR image, and a realtime outage never fails the webhook or the request.
 */
class WhatsAppRealtimeTest extends TestCase
{
    use InteractsWithRealtime, OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures;

    private const CHANNEL = 'private-whatsapp-admin';

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        settings()->set('auth.mode', 'fortify');
    }

    public function test_an_inbound_message_announces_the_message_and_the_chat_to_administrators_only(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = $this->webhookSession();

        $this->deliver($session, $this->messageReceived(['body' => 'Hello from a customer']))->assertOk();

        $created = $broadcaster->sole('wa.message.created');
        $this->assertSame([self::CHANNEL], $created['channels']);
        $this->assertSame(1, $created['payload']['v']);
        $this->assertSame('Hello from a customer', $created['payload']['message']['body']);
        $this->assertSame('in', $created['payload']['message']['direction']);
        $this->assertSame(1, $created['payload']['chat']['unreadByAdmin']);
        $this->assertSame($created['payload']['chat']['ulid'], $created['payload']['message']['chat']);

        $chat = $broadcaster->sole('wa.chat.updated');
        $this->assertSame([self::CHANNEL], $chat['channels']);
        $this->assertSame($created['payload']['chat'], $chat['payload']['chat']);
        $this->assertSame([self::CHANNEL], array_values(array_unique(array_merge(...array_column($broadcaster->published, 'channels')))), 'nothing went anywhere else');
    }

    public function test_no_wa_event_carries_a_whatsapp_internal_value(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = $this->webhookSession();

        $this->deliver($session, $this->messageReceived(['id' => 'false_4915123456789@c.us_INTERNAL1', 'body' => 'x']))->assertOk();

        $wire = json_encode($broadcaster->published);
        $this->assertStringNotContainsString('INTERNAL1', $wire, 'no WhatsApp message id');
        $this->assertStringNotContainsString('@c.us', $wire, 'no WhatsApp chat id');
        $this->assertStringNotContainsString((string) $session->openwa_session_id, $wire);
        $this->assertStringNotContainsString('raw', $wire);
    }

    public function test_an_ack_announces_the_updated_message(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = $this->webhookSession();
        $chat = WaChat::factory()->for($session, 'session')->create();
        $message = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['status' => WaMessageStatus::Sent, 'wa_message_id' => 'true_x_1']);

        $this->deliver($session, $this->messageAck('true_x_1', 'delivered'))->assertOk();

        $updated = $broadcaster->sole('wa.message.updated');
        $this->assertSame([self::CHANNEL], $updated['channels']);
        $this->assertSame($message->ulid, $updated['payload']['message']['ulid']);
        $this->assertSame('delivered', $updated['payload']['message']['status']);
    }

    public function test_linking_a_chat_announces_the_chat_with_its_widget_and_topic(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = $this->webhookSession();
        $widget = Widget::factory()->create(['name' => 'Main site']);
        WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'code' => 'K7M2QX4P', 'expires_at' => now()->addHour()]);

        $this->deliver($session, $this->messageReceived(['body' => 'K7M2QX4P']))->assertOk();

        $linked = array_values(array_filter($broadcaster->of('wa.chat.updated'), fn (array $entry): bool => $entry['payload']['chat']['linked'] === true));
        $this->assertNotEmpty($linked);
        $this->assertSame('Main site', $linked[0]['payload']['chat']['widget']['name']);
        $this->assertTrue($broadcaster->sole('wa.message.created')['payload']['chat']['linked'], 'the very first broadcast already shows the link');
    }

    public function test_a_session_change_announces_the_session_without_the_qr_image(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = $this->webhookSession(state: 'starting');

        $this->deliver($session, $this->envelope('session.qr', ['qr' => WhatsAppSessionFactory::FAKE_QR]))->assertOk();

        $status = $broadcaster->of('wa.session.status');
        $this->assertNotEmpty($status);
        $last = end($status);
        $this->assertSame([self::CHANNEL], $last['channels']);
        $this->assertSame('qr', $last['payload']['session']['status']);
        $this->assertTrue($last['payload']['session']['qrAvailable']);
        $wire = json_encode($broadcaster->published);
        $this->assertStringNotContainsString('iVBOR', $wire, 'the image is never broadcast');
        $this->assertStringNotContainsString('webhook_secret', $wire);
        $this->assertStringNotContainsString($session->webhook_secret, $wire);
    }

    public function test_every_event_goes_through_the_domain_events(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $session = WhatsAppSession::factory()->ready()->create();
        $chat = WaChat::factory()->for($session, 'session')->create();
        $message = WaMessage::factory()->for($chat, 'chat')->inbound()->create();
        $ticket = WaHandoffTicket::factory()->create(['widget_id' => Widget::factory()->create()->id, 'session_id' => $session->id]);

        WaMessageReceived::dispatch($message);
        WaMessageStatusChanged::dispatch($message, WaMessageStatus::Received);
        WaChatUpdated::dispatch($chat);
        WaChatLinked::dispatch($chat, $ticket);
        WaSessionStatusChanged::dispatch($session, SessionStatus::Starting);
        WaSessionQrUpdated::dispatch($session);

        $this->assertCount(1, $broadcaster->of('wa.message.created'));
        $this->assertCount(1, $broadcaster->of('wa.message.updated'));
        $this->assertCount(3, $broadcaster->of('wa.chat.updated'), 'received + updated + linked');
        $this->assertCount(2, $broadcaster->of('wa.session.status'));
    }

    public function test_a_realtime_outage_never_breaks_the_webhook(): void
    {
        $broadcaster = $this->recordBroadcasts();
        $broadcaster->failWith(new \RuntimeException('reverb is down'));
        $session = $this->webhookSession();

        $this->deliver($session, $this->messageReceived())->assertOk()->assertExactJson(['status' => 'accepted']);

        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame([], $broadcaster->published);
    }

    public function test_a_payload_that_cannot_be_built_never_breaks_the_webhook(): void
    {
        $this->recordBroadcasts();
        $session = $this->webhookSession();
        // The message is stored, then its chat vanishes before the broadcast is built.
        Event::listen(WaMessageReceived::class, fn (WaMessageReceived $event) => WaChat::query()->whereKey($event->message->wa_chat_id)->delete(), true);

        $this->deliver($session, $this->messageReceived())->assertOk();

        $this->assertInstanceOf(User::class, User::factory()->make());
    }
}
