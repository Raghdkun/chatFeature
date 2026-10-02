<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Closure;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\FakeOpenWaClient;
use Tests\Support\Images;
use Tests\Support\OpenWaFixtures;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * What OpenWA really delivers (`tests/fixtures/openwa/webhook-delivery-*`, recorded from the real 0.23.7 image with their real signatures) and
 * what the reference documents it delivers (`delivery-*`), replayed through the endpoint.
 */
class OpenWaDeliveryFixturesTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures;

    private const RECORDED_SECRET = 'test-webhook-secret-0123456789abcdef';

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
    }

    /** The fake OpenWA (public for the checks of the data sets). */
    public function fake(): FakeOpenWaClient
    {
        return $this->openWa();
    }

    /** The session a recording was made for: its OpenWA UUID and the secret its webhook was registered with. */
    private function sessionFor(string $openWaId, string $secret, string $state = 'starting'): WhatsAppSession
    {
        return WhatsAppSession::factory()->{$state}()->withWebhook($secret)->create(['openwa_session_id' => $openWaId, 'name' => 'rec-'.Str::lower(Str::random(8))]);
    }

    /**
     * @param  array<string, string>  $headers
     */
    private function replay(WhatsAppSession $session, string $rawBody, array $headers): TestResponse
    {
        $server = ['CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json'];

        foreach ($headers as $name => $value) {
            $server['HTTP_'.strtoupper(str_replace('-', '_', $name))] = $value;
        }

        return $this->call('POST', '/webhooks/openwa/'.$session->ulid, [], [], [], $server, $rawBody);
    }

    // ---- the recorded, really signed deliveries ----------------------------------------------------------------------------

    /**
     * @return iterable<string, array{string, SessionStatus, SessionStatus}>
     */
    public static function recordedStatusDeliveries(): iterable
    {
        yield 'initializing' => ['webhook-delivery-session-status-initializing', SessionStatus::Created, SessionStatus::Starting];
        yield 'qr_ready' => ['webhook-delivery-session-status-qr-ready', SessionStatus::Starting, SessionStatus::Qr];
        yield 'disconnected' => ['webhook-delivery-session-status-disconnected', SessionStatus::Qr, SessionStatus::Disconnected];
    }

    #[DataProvider('recordedStatusDeliveries')]
    public function test_a_really_signed_recorded_delivery_verifies_and_moves_the_session(string $fixture, SessionStatus $before, SessionStatus $after): void
    {
        $recorded = OpenWaFixtures::recordedDelivery($fixture);
        $session = $this->sessionFor($recorded['sessionId'], $recorded['secret'], 'starting');
        $session->forceFill(['status' => $before])->save();

        $this->replay($session, $recorded['rawBody'], $recorded['headers'])->assertOk()->assertExactJson(['status' => 'accepted']);

        $this->assertSame($after, $session->refresh()->status);
        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame($recorded['headers']['x-openwa-idempotency-key'], $delivery->idempotency_key);
        $this->assertSame($recorded['headers']['x-openwa-delivery-id'], $delivery->delivery_id);
        $this->assertSame(WebhookOutcome::Processed, $delivery->outcome);
    }

    #[DataProvider('recordedStatusDeliveries')]
    public function test_one_changed_byte_of_a_recorded_delivery_fails_the_signature(string $fixture): void
    {
        $recorded = OpenWaFixtures::recordedDelivery($fixture);
        $session = $this->sessionFor($recorded['sessionId'], $recorded['secret']);

        $this->replay($session, str_replace('"status"', '"stat us"', $recorded['rawBody']), $recorded['headers'])->assertUnauthorized();
        $this->replay($session, $recorded['rawBody'], $recorded['headers'])->assertOk();
        $this->assertSame(1, WaWebhookDelivery::query()->count());

        $other = $this->sessionFor('11111111-1111-4111-8111-111111111111', 'another-secret-another-secret-another-0001');
        $this->replay($other, $recorded['rawBody'], $recorded['headers'])->assertUnauthorized();
    }

    public function test_a_recorded_delivery_repeated_by_openwas_retry_is_a_no_op(): void
    {
        $recorded = OpenWaFixtures::recordedDelivery('webhook-delivery-session-status-qr-ready');
        $session = $this->sessionFor($recorded['sessionId'], $recorded['secret']);

        $this->replay($session, $recorded['rawBody'], $recorded['headers'])->assertExactJson(['status' => 'accepted']);
        // OpenWA's retry: same body, same ids, `X-OpenWA-Retry-Count: 1` (recorded: attempts at +0, +5 s, +15 s).
        $this->replay($session, $recorded['rawBody'], ['x-openwa-retry-count' => '1'] + $recorded['headers'])->assertExactJson(['status' => 'duplicate']);
        $this->replay($session, $recorded['rawBody'], ['x-openwa-retry-count' => '2'] + $recorded['headers'])->assertExactJson(['status' => 'duplicate']);

        $this->assertSame(1, WaWebhookDelivery::query()->count());
    }

    public function test_the_recorded_test_event_is_acknowledged_and_ignored(): void
    {
        $recorded = OpenWaFixtures::recordedDelivery('webhook-delivery-test');
        $session = $this->sessionFor($recorded['sessionId'], $recorded['secret'], 'ready');

        $this->replay($session, $recorded['rawBody'], $recorded['headers'])->assertOk();

        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame('test', $delivery->event);
        $this->assertStringStartsWith('evt_test_', $delivery->idempotency_key);
        $this->assertSame(WebhookOutcome::Ignored, $delivery->outcome);
        $this->assertSame(SessionStatus::Ready, $session->refresh()->status);
    }

    public function test_a_recorded_qr_event_is_accepted_but_a_scrubbed_image_is_never_stored(): void
    {
        // The recording scrubbed the image (`<REDACTED>`), which also breaks its signature: the file says so.
        $this->assertFalse(OpenWaFixtures::file('webhook-delivery-session-qr')['verification']['reverifiableFromThisFile']);

        $recorded = OpenWaFixtures::recordedDelivery('webhook-delivery-session-qr');
        $session = $this->sessionFor($recorded['sessionId'], $recorded['secret']);
        $payload = json_decode($recorded['rawBody'], true);
        $this->assertStringContainsString('<REDACTED>', $payload['data']['qr']);

        $signed = json_encode($payload, JSON_UNESCAPED_SLASHES);
        $this->deliver($session, (string) $signed, headers: ['X-OpenWA-Event' => 'session.qr', 'X-OpenWA-Idempotency-Key' => $recorded['headers']['x-openwa-idempotency-key']])->assertOk();

        $this->assertNull($session->refresh()->last_qr, 'not a PNG: refused');
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);
    }

    public function test_a_delivery_for_another_openwa_session_is_not_applied_even_when_it_is_signed(): void
    {
        $recorded = OpenWaFixtures::recordedDelivery('webhook-delivery-session-status-qr-ready');
        // This URL belongs to a session whose OpenWA id is different: the body names the recorded one.
        $session = $this->sessionFor('22222222-2222-4222-8222-222222222222', $recorded['secret']);

        $this->replay($session, $recorded['rawBody'], $recorded['headers'])->assertOk();

        $this->assertSame(SessionStatus::Starting, $session->refresh()->status);
        $delivery = WaWebhookDelivery::query()->sole();
        $this->assertSame(WebhookOutcome::Ignored, $delivery->outcome);
        $this->assertSame('Delivered for another OpenWA session.', $delivery->error);
    }

    // ---- the documented deliveries -----------------------------------------------------------------------------------------

    /**
     * Fixture => a check of what must have happened (the session is ready, with a customer chat of `4915112345678`).
     *
     * @return iterable<string, array{string, WebhookOutcome, Closure(self): void}>
     */
    public static function documentedDeliveries(): iterable
    {
        yield 'text (whatsapp-web.js)' => ['delivery-message-received-text', WebhookOutcome::Processed, function (self $t): void {
            $chat = WaChat::query()->sole();
            $t->assertSame('4915112345678@c.us', $chat->chat_id);
            $t->assertSame('+4915112345678', $chat->phone_e164);
            $t->assertSame('Vera Visitor', $chat->push_name);
            $t->assertSame('Hi! My support code is K7M2QX4P', WaMessage::query()->sole()->body);
            $t->assertSame(1, $chat->unread_by_admin);
        }];
        yield 'text (baileys dialect and a raw key id)' => ['delivery-message-received-text-baileys', WebhookOutcome::Processed, function (self $t): void {
            $t->assertSame('4915112345678@c.us', WaChat::query()->sole()->chat_id, 'one customer, whichever engine');
            $t->assertSame('3EB0A1B2C3D4E5F60718', WaMessage::query()->sole()->wa_message_id);
        }];
        yield 'privacy id with the resolved number' => ['delivery-message-received-lid', WebhookOutcome::Processed, function (self $t): void {
            $chat = WaChat::query()->sole();
            $t->assertSame('123456789012345@lid', $chat->chat_id);
            $t->assertSame('+4915112345678', $chat->phone_e164);
        }];
        yield 'group' => ['delivery-message-received-group', WebhookOutcome::Ignored, fn (self $t) => $t->assertSame(0, WaChat::query()->count())];
        yield 'story' => ['delivery-message-received-status', WebhookOutcome::Ignored, fn (self $t) => $t->assertSame(0, WaChat::query()->count())];
        yield 'channel' => ['delivery-message-received-channel', WebhookOutcome::Ignored, fn (self $t) => $t->assertSame(0, WaChat::query()->count())];
        yield 'sent from the phone itself' => ['delivery-message-received-from-me', WebhookOutcome::Processed, function (self $t): void {
            $message = WaMessage::query()->sole();
            $t->assertSame(WaDirection::Out, $message->direction);
            $t->assertSame(0, WaChat::query()->sole()->unread_by_admin);
            $t->assertFalse(WaChat::query()->sole()->inbound_initiated);
        }];
        yield 'image, inline' => ['delivery-message-received-image-inline', WebhookOutcome::Processed, function (self $t): void {
            $message = WaMessage::query()->sole();
            $t->assertSame(WaMessageType::Image, $message->type);
            $t->assertSame('Here is the receipt', $message->body);
        }];
        yield 'image, too large to inline' => ['delivery-message-received-image-omitted', WebhookOutcome::Processed, function (self $t): void {
            $message = WaMessage::query()->sole();
            $t->assertSame(WaMessageType::Image, $message->type);
            $t->assertTrue($message->hasStoredMedia(), 'fetched through the media route');
            $t->fake()->assertCalled('downloadMedia', fn (array $args): bool => $args['messageId'] === 'false_4915112345678@c.us_3EB0F00D0002' && $args['chatId'] === '4915112345678@c.us', 1);
        }];
        yield 'document' => ['delivery-message-received-document', WebhookOutcome::Processed, function (self $t): void {
            $message = WaMessage::query()->sole();
            $t->assertSame(WaMessageType::Document, $message->type);
            $t->assertFalse($message->hasStoredMedia());
            $t->assertSame('application/pdf', $message->media_mime);
        }];
        yield 'voice note' => ['delivery-message-received-voice', WebhookOutcome::Processed, function (self $t): void {
            $t->assertSame(WaMessageType::Voice, WaMessage::query()->sole()->type);
            $t->assertSame('Voice message', WaChat::query()->sole()->last_message_preview);
        }];
        yield 'session ready' => ['delivery-session-status-ready', WebhookOutcome::Processed, fn (self $t) => $t->assertSame(SessionStatus::Ready, WhatsAppSession::query()->sole()->status)];
        yield 'authenticated' => ['delivery-session-authenticated', WebhookOutcome::Processed, function (self $t): void {
            $session = WhatsAppSession::query()->sole();
            $t->assertSame(SessionStatus::Ready, $session->status);
            $t->assertSame('+4915100000000', $session->phone_e164);
            $t->assertSame('PNE Support', $session->push_name);
        }];
        yield 'disconnected' => ['delivery-session-disconnected', WebhookOutcome::Processed, function (self $t): void {
            $session = WhatsAppSession::query()->sole();
            $t->assertSame(SessionStatus::Disconnected, $session->status);
            $t->assertSame('Disconnected: LOGOUT', $session->last_error);
        }];
        yield 'reconnect loop' => ['delivery-session-reconnect-loop', WebhookOutcome::Processed, fn (self $t) => $t->assertStringContainsString('attempt 5', (string) WhatsAppSession::query()->sole()->last_error)];
    }

    /**
     * @param  Closure(self): void  $check
     */
    #[DataProvider('documentedDeliveries')]
    public function test_a_documented_delivery_is_applied_as_described(string $fixture, WebhookOutcome $outcome, Closure $check): void
    {
        $delivery = OpenWaFixtures::delivery($fixture);
        $session = $this->sessionFor($delivery['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $this->openWa()->will('downloadMedia', new OpenWaMedia(Images::jpeg(24, 24), 'image/jpeg', 'IMG_0042.jpg'));
        $this->fixInlineImage($delivery['payload']);

        $this->deliver($session, $delivery['payload'])->assertOk()->assertExactJson(['status' => 'accepted']);

        $this->assertSame($outcome, WaWebhookDelivery::query()->sole()->outcome, $fixture);
        $check($this);
    }

    /**
     * A documented inline image carries placeholder text, not bytes: give it real ones (the shape is what the fixture documents).
     *
     * @param  array<string, mixed>  $payload
     */
    private function fixInlineImage(array &$payload): void
    {
        if (isset($payload['data']['media']['data'])) {
            $payload['data']['media']['data'] = base64_encode(Images::jpeg(24, 24));
        }
    }

    public function test_the_documented_acks_move_a_reply_forward_by_message_id(): void
    {
        $delivery = OpenWaFixtures::delivery('delivery-message-ack-delivered');
        $session = $this->sessionFor($delivery['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $chat = WaChat::factory()->for($session, 'session')->create(['chat_id' => '4915112345678@c.us']);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['wa_message_id' => 'true_4915112345678@c.us_3EB0AB12CD34', 'status' => WaMessageStatus::Sent]);

        foreach (['delivery-message-ack-delivered' => WaMessageStatus::Delivered, 'delivery-message-ack-read' => WaMessageStatus::Read, 'delivery-message-ack-sent' => WaMessageStatus::Read] as $fixture => $expected) {
            $this->deliver($session, OpenWaFixtures::delivery($fixture)['payload'])->assertOk();
            $this->assertSame($expected, $reply->refresh()->status, $fixture);
        }
    }

    public function test_the_documented_failure_marks_a_reply_failed_and_never_a_delivered_one(): void
    {
        $failed = OpenWaFixtures::delivery('delivery-message-failed');
        $session = $this->sessionFor($failed['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $chat = WaChat::factory()->for($session, 'session')->create(['chat_id' => '4915112345678@c.us']);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['wa_message_id' => 'true_4915112345678@c.us_3EB0AB12CD34', 'status' => WaMessageStatus::Sent]);

        $this->deliver($session, $failed['payload'])->assertOk();

        $this->assertSame(WaMessageStatus::Failed, $reply->refresh()->status);
    }

    public function test_an_ack_whose_id_differs_from_its_message_id_is_found_by_either(): void
    {
        $delivery = OpenWaFixtures::delivery('delivery-message-ack-delivered');
        $session = $this->sessionFor($delivery['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $chat = WaChat::factory()->for($session, 'session')->create();
        $byId = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['wa_message_id' => 'only-the-id', 'status' => WaMessageStatus::Sent]);
        $byMessageId = WaMessage::factory()->for($chat, 'chat')->outbound()->create(['wa_message_id' => 'only-the-message-id', 'status' => WaMessageStatus::Sent]);

        $payload = $delivery['payload'];
        $payload['data'] = ['id' => 'only-the-id', 'messageId' => 'something-else-entirely', 'status' => 'read', 'ack' => 3];
        $this->deliver($session, $payload)->assertOk();
        $payload['data'] = ['id' => 'another-internal-id', 'messageId' => 'only-the-message-id', 'status' => 'delivered', 'ack' => 2];
        $payload['idempotencyKey'] = 'second-ack';
        $this->deliver($session, $payload)->assertOk();

        $this->assertSame(WaMessageStatus::Read, $byId->refresh()->status);
        $this->assertSame(WaMessageStatus::Delivered, $byMessageId->refresh()->status);
    }

    public function test_the_documented_echo_of_a_reply_the_app_made_is_not_recorded_twice(): void
    {
        $echo = OpenWaFixtures::delivery('delivery-message-sent-echo');
        $session = $this->sessionFor($echo['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $chat = WaChat::factory()->for($session, 'session')->create(['chat_id' => '4915112345678@c.us']);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound()->pending()->create(['body' => 'Hi Vera, I am looking at it now.']);

        $this->deliver($session, $echo['payload'])->assertOk();

        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame('true_4915112345678@c.us_3EB0AB12CD34', $reply->refresh()->wa_message_id);
    }

    public function test_the_documented_text_with_the_code_links_a_chat_to_its_hand_off_ticket(): void
    {
        $delivery = OpenWaFixtures::delivery('delivery-message-received-text');
        $session = $this->sessionFor($delivery['payload']['sessionId'], 'a-webhook-secret-of-forty-characters-0001', 'ready');
        $widget = Widget::factory()->create();
        $ticket = WaHandoffTicket::factory()->create(['widget_id' => $widget->id, 'session_id' => $session->id, 'code' => 'K7M2QX4P', 'expires_at' => now()->addHour()]);

        $this->deliver($session, $delivery['payload'])->assertOk();

        $this->assertSame($ticket->id, WaChat::query()->sole()->handoff_ticket_id);
    }

    public function test_every_documented_delivery_fixture_is_covered_by_a_test_above(): void
    {
        $covered = [
            'delivery-message-received-text', 'delivery-message-received-text-baileys', 'delivery-message-received-lid', 'delivery-message-received-group',
            'delivery-message-received-status', 'delivery-message-received-channel', 'delivery-message-received-from-me', 'delivery-message-received-image-inline',
            'delivery-message-received-image-omitted', 'delivery-message-received-document', 'delivery-message-received-voice', 'delivery-session-status-ready',
            'delivery-session-authenticated', 'delivery-session-disconnected', 'delivery-session-reconnect-loop', 'delivery-message-ack-delivered',
            'delivery-message-ack-read', 'delivery-message-ack-sent', 'delivery-message-failed', 'delivery-message-sent-echo',
        ];

        $this->assertEqualsCanonicalizing($covered, OpenWaFixtures::names('delivery-'), 'a new documented delivery needs a test');
    }
}
