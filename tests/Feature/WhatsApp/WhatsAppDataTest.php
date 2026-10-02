<?php

namespace Tests\Feature\WhatsApp;

use App\Data\WhatsApp\Events\WaChatUpdatedPayload;
use App\Data\WhatsApp\Events\WaMessageCreatedPayload;
use App\Data\WhatsApp\Events\WaMessageUpdatedPayload;
use App\Data\WhatsApp\Events\WaSessionStatusPayload;
use App\Data\WhatsApp\HandoffData;
use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMediaData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use LogicException;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;
use Tests\TestCase;

/**
 * The WhatsApp Data classes: exact key sets (camelCase, what the TypeScript types are generated from), ISO timestamps and the values
 * an administrator's inbox needs.
 */
class WhatsAppDataTest extends TestCase
{
    use RefreshDatabase;

    /**
     * @return array<string, mixed>
     */
    private function payload(Data $data): array
    {
        return json_decode(json_encode($data->toArray(), JSON_THROW_ON_ERROR), true, 512, JSON_THROW_ON_ERROR);
    }

    private function assertKeys(array $expected, array $actual): void
    {
        $this->assertEqualsCanonicalizing($expected, array_keys($actual));
    }

    public function test_a_session_as_the_settings_page_shows_it(): void
    {
        settings()->set('app.url', 'https://chat.example.com');
        $session = WhatsAppSession::factory()->qr()->create(['name' => 'support-main', 'phone_e164' => '+4915123456789', 'push_name' => 'PNE Support']);
        Widget::factory()->count(2)->withWhatsAppSession($session)->create();

        $json = $this->payload(WhatsAppSessionData::fromModel($session));

        $this->assertKeys([
            'ulid', 'name', 'engine', 'status', 'phone', 'maskedPhone', 'pushName', 'qrAvailable', 'lastQrAt', 'webhookRegistered', 'webhookUrl',
            'readyAt', 'lastError', 'linkedWidgetsCount', 'isLinkedToWidgets', 'sendMinIntervalMs', 'dailySendCap', 'pacingOverridden', 'createdAt',
        ], $json);
        $this->assertSame($session->ulid, $json['ulid']);
        $this->assertSame('support-main', $json['name']);
        $this->assertSame('whatsapp-web.js', $json['engine']);
        $this->assertSame('qr', $json['status']);
        $this->assertSame('+4915123456789', $json['phone']);
        $this->assertSame('+49•••••••6789', $json['maskedPhone']);
        $this->assertSame('PNE Support', $json['pushName']);
        $this->assertTrue($json['qrAvailable']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $json['lastQrAt']);
        $this->assertTrue($json['webhookRegistered']);
        $this->assertSame('https://chat.example.com/webhooks/openwa/'.$session->ulid, $json['webhookUrl']);
        $this->assertNull($json['readyAt']);
        $this->assertSame(2, $json['linkedWidgetsCount']);
        $this->assertTrue($json['isLinkedToWidgets']);
        $this->assertSame(1500, $json['sendMinIntervalMs']);
        $this->assertSame(200, $json['dailySendCap']);
        $this->assertFalse($json['pacingOverridden']);
    }

    public function test_the_widget_count_comes_from_withcount_when_the_query_loaded_it(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        Widget::factory()->withWhatsAppSession($session)->create();

        $loaded = WhatsAppSession::query()->withCount('widgets')->findOrFail($session->id);

        $this->assertSame(1, WhatsAppSessionData::fromModel($loaded)->linkedWidgetsCount);
        $this->assertSame(1, WhatsAppSessionData::fromModel($session)->linkedWidgetsCount, 'and from one count query when it was not');
    }

    public function test_an_unconnected_session_has_no_qr_no_widgets_and_reports_overridden_pacing(): void
    {
        $session = WhatsAppSession::factory()->withPacing(sendMinIntervalMs: 3000)->create();

        $data = WhatsAppSessionData::fromModel($session);

        $this->assertFalse($data->qrAvailable);
        $this->assertFalse($data->webhookRegistered);
        $this->assertNull($data->phone);
        $this->assertNull($data->maskedPhone);
        $this->assertSame(0, $data->linkedWidgetsCount);
        $this->assertFalse($data->isLinkedToWidgets);
        $this->assertSame(3000, $data->sendMinIntervalMs);
        $this->assertTrue($data->pacingOverridden);
    }

    public function test_a_chat_row_of_the_inbox(): void
    {
        $category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $chat = WaChat::factory()->linked(category: $category)->unread(3)->create(['push_name' => 'Vera', 'last_message_preview' => 'Where is my invoice?']);

        $json = $this->payload(WaChatData::fromModel($chat->load(['session', 'widget', 'category'])));

        $this->assertKeys([
            'ulid', 'session', 'phone', 'pushName', 'isGroup', 'status', 'linked', 'widget', 'category', 'unreadByAdmin', 'inboundInitiated',
            'lastInboundAt', 'lastMessageAt', 'lastMessagePreview', 'createdAt',
        ], $json);
        $this->assertSame($chat->ulid, $json['ulid']);
        $this->assertSame(['ulid' => $chat->session->ulid, 'name' => $chat->session->name], $json['session']);
        $this->assertSame($chat->phone_e164, $json['phone']);
        $this->assertSame('Vera', $json['pushName']);
        $this->assertFalse($json['isGroup']);
        $this->assertSame('open', $json['status']);
        $this->assertTrue($json['linked']);
        $this->assertSame(['ulid' => $chat->widget->ulid, 'name' => $chat->widget->name], $json['widget']);
        $this->assertSame(['slug' => 'billing', 'label' => 'Billing'], $json['category']);
        $this->assertSame(3, $json['unreadByAdmin']);
        $this->assertTrue($json['inboundInitiated']);
        $this->assertSame('Where is my invoice?', $json['lastMessagePreview']);
        $this->assertMatchesRegularExpression('/Z$/', $json['lastMessageAt']);
    }

    public function test_a_chat_without_a_link_has_no_widget_and_no_category(): void
    {
        $json = $this->payload(WaChatData::fromModel(WaChat::factory()->group()->archived()->create()->load('session')));

        $this->assertFalse($json['linked']);
        $this->assertNull($json['widget']);
        $this->assertNull($json['category']);
        $this->assertNull($json['phone']);
        $this->assertTrue($json['isGroup']);
        $this->assertSame('archived', $json['status']);
        $this->assertNull($json['lastMessageAt']);
    }

    public function test_the_chat_detail_adds_the_visitor_and_the_ticket_that_linked_it(): void
    {
        $widget = Widget::factory()->create();
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => 'Vera Visitor', 'email' => 'vera@visitor.example', 'phone' => '+1 555 0100', 'verified' => true, 'meta' => ['plan' => 'pro'], 'external_id' => 'host-user-42']);
        $chat = WaChat::factory()->linked($widget, $visitor)->create();
        $ticket = WaHandoffTicket::query()->findOrFail($chat->handoff_ticket_id);

        $json = $this->payload(WaChatDetailData::fromModel($chat->load(['session', 'widget', 'category', 'visitor', 'handoffTicket'])));

        $this->assertKeys(['chat', 'visitor', 'handoff'], $json);
        $this->assertSame($chat->ulid, $json['chat']['ulid']);
        $this->assertSame(['ulid' => $visitor->ulid, 'name' => 'Vera Visitor', 'email' => 'vera@visitor.example', 'phone' => '+1 555 0100', 'verified' => true], $json['visitor']);
        $this->assertKeys(['code', 'createdAt', 'consumedAt'], $json['handoff']);
        $this->assertSame($ticket->code, $json['handoff']['code']);
        $this->assertNotNull($json['handoff']['consumedAt']);
        $this->assertStringNotContainsString('host-user-42', (string) json_encode($json), 'no external id, no host-site metadata');
        $this->assertStringNotContainsString('pro', (string) json_encode($json['visitor']));
    }

    public function test_the_chat_detail_of_an_unmatched_chat_has_no_visitor_and_no_ticket(): void
    {
        $json = $this->payload(WaChatDetailData::fromModel(WaChat::factory()->create()->load(['session', 'widget', 'category', 'visitor', 'handoffTicket'])));

        $this->assertNull($json['visitor']);
        $this->assertNull($json['handoff']);
    }

    public function test_an_inbound_text_message(): void
    {
        $chat = WaChat::factory()->create();
        $message = WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'body' => 'Hello!']);

        $json = $this->payload(WaMessageData::fromModel($message->load(['chat', 'sentBy'])));

        $this->assertKeys(['ulid', 'chat', 'direction', 'type', 'body', 'media', 'status', 'error', 'sentBy', 'waTimestamp', 'createdAt'], $json);
        $this->assertSame($message->ulid, $json['ulid']);
        $this->assertSame($chat->ulid, $json['chat']);
        $this->assertSame('in', $json['direction']);
        $this->assertSame('text', $json['type']);
        $this->assertSame('Hello!', $json['body']);
        $this->assertNull($json['media']);
        $this->assertSame('received', $json['status']);
        $this->assertNull($json['error']);
        $this->assertNull($json['sentBy']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $json['waTimestamp']);
    }

    public function test_an_outbound_reply_names_the_administrator_and_its_progress(): void
    {
        $admin = User::factory()->admin()->create(['name' => 'Ada Admin', 'display_name' => 'Ada']);
        $message = WaMessage::factory()->outbound($admin)->delivered()->create(['body' => 'It ships today.']);

        $data = WaMessageData::fromModel($message->load(['chat', 'sentBy']));

        $this->assertSame(WaDirection::Out, $data->direction);
        $this->assertSame(WaMessageStatus::Delivered, $data->status);
        $this->assertSame(['id' => $admin->id, 'name' => 'Ada'], $this->payload($data)['sentBy']);
    }

    public function test_a_failed_message_carries_a_bounded_error_text(): void
    {
        $message = WaMessage::factory()->outbound()->failed(str_repeat('x', 900))->create();

        $data = WaMessageData::fromModel($message->load(['chat', 'sentBy']));

        $this->assertSame(WaMessageStatus::Failed, $data->status);
        $this->assertNotNull($data->error);
        $this->assertLessThanOrEqual(500, mb_strlen($data->error));
    }

    public function test_a_stored_image_has_a_signed_url_and_a_typed_document_has_none(): void
    {
        $image = WaMessage::factory()->image('look')->create();
        $document = WaMessage::factory()->document('invoice.pdf')->create();

        $imageJson = $this->payload(WaMessageData::fromModel($image->load(['chat', 'sentBy'])));
        $this->assertKeys(['mime', 'filename', 'size', 'available', 'url'], $imageJson['media']);
        $this->assertSame('image', $imageJson['type']);
        $this->assertSame('look', $imageJson['body']);
        $this->assertSame('image/jpeg', $imageJson['media']['mime']);
        $this->assertTrue($imageJson['media']['available']);
        $this->assertSame('https://files.test/whatsapp/'.$image->ulid.'?signature=fake', $imageJson['media']['url']);

        $documentJson = $this->payload(WaMessageData::fromModel($document->load(['chat', 'sentBy'])));
        $this->assertSame(['mime' => 'application/pdf', 'filename' => 'invoice.pdf', 'size' => 120400, 'available' => false, 'url' => null], $documentJson['media']);
    }

    public function test_an_inbound_media_row_without_details_still_says_there_was_media(): void
    {
        $message = WaMessage::factory()->create(['type' => WaMessageType::Sticker, 'body' => null]);

        $media = WaMessageData::fromModel($message->load(['chat', 'sentBy']))->media;

        $this->assertInstanceOf(WaMediaData::class, $media);
        $this->assertFalse($media->available);
        $this->assertNull($media->url);
    }

    public function test_the_handoff_response_has_exactly_three_keys(): void
    {
        $session = WhatsAppSession::factory()->ready('+4915123456789')->create();
        $ticket = WaHandoffTicket::factory()->create(['session_id' => $session->id, 'code' => 'K7M2QX3P']);

        $json = $this->payload(HandoffData::fromTicket($ticket->load('session')));

        $this->assertKeys(['code', 'waUrl', 'expiresAt'], $json);
        $this->assertSame('K7M2QX3P', $json['code']);
        $this->assertSame('https://wa.me/4915123456789?text=Hi%21%20My%20support%20code%20is%20K7M2QX3P', $json['waUrl']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $json['expiresAt']);
    }

    public function test_the_handoff_text_is_the_setting_unless_a_template_is_given(): void
    {
        settings()->set('whatsapp.handoff_text', 'Support code: :code, please');
        $ticket = WaHandoffTicket::factory()->create(['session_id' => WhatsAppSession::factory()->ready('+4915123456789')->create()->id, 'code' => 'ABCD2345']);

        $this->assertSame('https://wa.me/4915123456789?text=Support%20code%3A%20ABCD2345%2C%20please', HandoffData::fromTicket($ticket)->waUrl);
        $this->assertSame('https://wa.me/4915123456789?text=Code%20ABCD2345', HandoffData::fromTicket($ticket, 'Code :code')->waUrl);
    }

    public function test_a_hand_off_needs_a_connected_number(): void
    {
        $ticket = WaHandoffTicket::factory()->create(['session_id' => WhatsAppSession::factory()->create()->id]);

        $this->expectException(LogicException::class);

        HandoffData::fromTicket($ticket);
    }

    public function test_the_realtime_payloads_start_with_version_one_and_carry_their_data(): void
    {
        $chat = WaChat::factory()->create(['last_message_preview' => 'Hi'])->load(['session', 'widget', 'category']);
        $message = WaMessage::factory()->create(['wa_chat_id' => $chat->id])->load(['chat', 'sentBy']);
        $session = WhatsAppSession::factory()->qr()->create();

        $created = $this->payload(new WaMessageCreatedPayload(WaMessageData::fromModel($message), WaChatData::fromModel($chat)));
        $this->assertKeys(['v', 'message', 'chat'], $created);
        $this->assertSame(1, $created['v']);
        $this->assertSame($message->ulid, $created['message']['ulid']);
        $this->assertSame($chat->ulid, $created['chat']['ulid']);

        $updated = $this->payload(new WaMessageUpdatedPayload(WaMessageData::fromModel($message)));
        $this->assertKeys(['v', 'message'], $updated);
        $this->assertSame(1, $updated['v']);

        $chatUpdated = $this->payload(new WaChatUpdatedPayload(WaChatData::fromModel($chat)));
        $this->assertKeys(['v', 'chat'], $chatUpdated);
        $this->assertSame(1, $chatUpdated['v']);

        $status = $this->payload(new WaSessionStatusPayload(WhatsAppSessionData::fromModel($session)));
        $this->assertKeys(['v', 'session'], $status);
        $this->assertSame(1, $status['v']);
        $this->assertSame('qr', $status['session']['status']);
        $this->assertTrue($status['session']['qrAvailable'], 'the payload says a QR is there; the image is fetched over REST');
        $this->assertSame(SessionStatus::Qr->value, $status['session']['status']);
    }

    public function test_every_data_class_is_exported_to_typescript(): void
    {
        $files = array_merge(glob(app_path('Data/WhatsApp/*.php')) ?: [], glob(app_path('Data/WhatsApp/Events/*.php')) ?: []);
        $this->assertCount(17, $files, 'thirteen Data classes (four of them added by the backend track: settings, QR, connection test, widget link) and four realtime payloads');

        foreach ($files as $file) {
            $class = 'App\\Data\\WhatsApp\\'.str_replace(['/', '.php'], ['\\', ''], substr($file, strlen(app_path('Data/WhatsApp/'))));
            $this->assertNotEmpty(
                (new \ReflectionClass($class))->getAttributes(TypeScript::class),
                "{$class} needs #[TypeScript]",
            );
        }
    }
}
