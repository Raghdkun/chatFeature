<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\WaChatStatus;
use App\Domain\WhatsApp\Enums\WaDirection;
use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Domain\WhatsApp\Enums\WaMessageType;
use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Domain\WhatsApp\Events\WaMessageReceived;
use App\Domain\WhatsApp\Events\WaMessageSent;
use App\Domain\WhatsApp\Events\WaMessageStatusChanged;
use App\Domain\WhatsApp\Jobs\FetchInboundMedia;
use App\Domain\WhatsApp\Jobs\ProcessWebhookDelivery;
use App\Domain\WhatsApp\Services\WaMediaStore;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\OpenWa\OpenWaMedia;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\Images;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\TestCase;

/**
 * `message.received` / `message.sent` end to end through the webhook: chats and messages are created from OpenWA's message object,
 * tolerantly, and every repeat, race and odd input is safe.
 */
class InboundMessageProcessingTest extends TestCase
{
    use OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures;

    private WhatsAppSession $session;

    protected function setUp(): void
    {
        parent::setUp();

        $this->session = $this->webhookSession();
        Storage::fake('local');
    }

    // ---- the basics --------------------------------------------------------------------------------------------------------

    public function test_a_first_message_creates_the_chat_and_the_row_with_everything_the_inbox_needs(): void
    {
        Event::fake([WaMessageReceived::class]);

        $this->deliver($this->session, $this->messageReceived(['id' => 'false_4915123456789@c.us_AAA', 'body' => "Hello,\r\nI have a question", 'timestamp' => 1_780_000_000]))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertSame($this->session->id, $chat->session_id);
        $this->assertSame('4915123456789@c.us', $chat->chat_id);
        $this->assertSame('+4915123456789', $chat->phone_e164);
        $this->assertSame('Anna', $chat->push_name);
        $this->assertFalse($chat->is_group);
        $this->assertSame(WaChatStatus::Open, $chat->status);
        $this->assertTrue($chat->inbound_initiated);
        $this->assertSame(1, $chat->unread_by_admin);
        $this->assertSame(1_780_000_000, $chat->last_message_at?->getTimestamp());
        $this->assertSame(1_780_000_000, $chat->last_inbound_at?->getTimestamp());
        $this->assertSame('Hello, I have a question', $chat->last_message_preview);
        $this->assertNull($chat->widget_id);

        $message = WaMessage::query()->sole();
        $this->assertSame($chat->id, $message->wa_chat_id);
        $this->assertSame(WaDirection::In, $message->direction);
        $this->assertSame(WaMessageStatus::Received, $message->status);
        $this->assertSame(WaMessageType::Text, $message->type);
        $this->assertSame("Hello,\nI have a question", $message->body, 'line endings normalised, text kept');
        $this->assertSame('false_4915123456789@c.us_AAA', $message->wa_message_id);
        $this->assertSame(1_780_000_000, $message->wa_timestamp->getTimestamp());
        $this->assertSame('Anna', $message->raw['contact']['pushName'], 'the raw object is kept');
        $this->assertNull($message->sent_by_user_id);

        Event::assertDispatched(WaMessageReceived::class, fn (WaMessageReceived $event): bool => $event->message->is($message) && $event->message->chat->is($chat));
    }

    public function test_more_messages_count_up_and_the_preview_follows_the_latest(): void
    {
        foreach (['one', 'two', 'three'] as $index => $text) {
            $this->deliver($this->session, $this->messageReceived(['body' => $text, 'timestamp' => 1_780_000_000 + $index]))->assertOk();
        }

        $chat = WaChat::query()->sole();
        $this->assertSame(3, $chat->unread_by_admin);
        $this->assertSame('three', $chat->last_message_preview);
        $this->assertSame(3, WaMessage::query()->count());
    }

    public function test_the_last_message_only_moves_forward_when_deliveries_arrive_out_of_order(): void
    {
        $this->deliver($this->session, $this->messageReceived(['body' => 'newer', 'timestamp' => 1_780_000_100]))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['body' => 'older', 'timestamp' => 1_780_000_000]))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertSame('newer', $chat->last_message_preview);
        $this->assertSame(1_780_000_100, $chat->last_message_at?->getTimestamp());
        $this->assertSame(2, $chat->unread_by_admin, 'the older one still counts as unread');
    }

    public function test_a_second_delivery_of_the_same_message_under_another_key_is_a_duplicate_and_changes_nothing(): void
    {
        $first = $this->messageReceived(['id' => 'false_4915123456789@c.us_SAME'], key: 'msg_support-main_SAME_webhook-one');
        $again = $this->messageReceived(['id' => 'false_4915123456789@c.us_SAME'], key: 'msg_support-main_SAME_webhook-two');

        $this->deliver($this->session, $first)->assertOk();
        $this->deliver($this->session, $again)->assertOk();

        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(1, WaChat::query()->sole()->unread_by_admin);
        $outcomes = WaWebhookDelivery::query()->orderBy('id')->pluck('outcome')->all();
        $this->assertSame([WebhookOutcome::Processed, WebhookOutcome::Duplicate], $outcomes);
    }

    public function test_an_ack_style_unknown_fields_and_new_types_never_fail_a_delivery(): void
    {
        $body = $this->messageReceived(['type' => 'poll', 'body' => null, 'brandNewField' => ['x' => 1], 'order' => ['orderId' => 'o1'], 'buttons' => [['id' => 'a', 'text' => 'Yes']]]);

        $this->deliver($this->session, $body)->assertOk();

        $message = WaMessage::query()->sole();
        $this->assertSame(WaMessageType::Other, $message->type);
        $this->assertNull($message->body);
        $this->assertSame('Message', WaChat::query()->sole()->last_message_preview);
        $this->assertSame(WebhookOutcome::Processed, WaWebhookDelivery::query()->sole()->outcome);
    }

    /**
     * @return iterable<string, array{string, WaMessageType}>
     */
    public static function types(): iterable
    {
        yield 'text' => ['text', WaMessageType::Text];
        yield 'engine name chat' => ['chat', WaMessageType::Text];
        yield 'voice note ptt' => ['ptt', WaMessageType::Voice];
        yield 'audio' => ['audio', WaMessageType::Audio];
        yield 'video' => ['video', WaMessageType::Video];
        yield 'document' => ['document', WaMessageType::Document];
        yield 'sticker' => ['sticker', WaMessageType::Sticker];
        yield 'location' => ['location', WaMessageType::Location];
        yield 'vcard' => ['vcard', WaMessageType::Contact];
        yield 'revoked' => ['revoked', WaMessageType::Other];
        yield 'garbage' => ['x-future-type', WaMessageType::Other];
    }

    #[DataProvider('types')]
    public function test_message_types_are_mapped_tolerantly(string $wire, WaMessageType $expected): void
    {
        $this->deliver($this->session, $this->messageReceived(['type' => $wire]))->assertOk();

        $this->assertSame($expected, WaMessage::query()->sole()->type);
    }

    public function test_a_message_without_an_id_or_chat_is_acknowledged_as_ignored_not_failed(): void
    {
        $noId = $this->messageReceived();
        unset($noId['data']['id']);
        $noChat = $this->messageReceived(['chatId' => null, 'from' => null], key: 'no-chat');

        $this->deliver($this->session, $noId)->assertOk();
        $this->deliver($this->session, $noChat)->assertOk();

        $this->assertSame(0, WaMessage::query()->count());
        $this->assertSame([WebhookOutcome::Ignored, WebhookOutcome::Ignored], WaWebhookDelivery::query()->orderBy('id')->pluck('outcome')->all());
    }

    public function test_control_characters_and_bidi_overrides_never_reach_the_stored_text(): void
    {
        $this->deliver($this->session, $this->messageReceived(['body' => "Hi\x00\x07 there \u{202E}evil\u{202C}"]))->assertOk();

        $this->assertSame('Hi there evil', WaMessage::query()->sole()->body);
    }

    public function test_a_wildly_wrong_timestamp_is_replaced_by_now(): void
    {
        $this->deliver($this->session, $this->messageReceived(['timestamp' => 4_102_444_800]))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['timestamp' => 'not a time']))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['timestamp' => 1_780_000_000_000]))->assertOk();

        $stamps = WaMessage::query()->orderBy('id')->get()->map(fn (WaMessage $message): int => $message->wa_timestamp->getTimestamp())->all();
        $this->assertEqualsWithDelta(now()->getTimestamp(), $stamps[0], 5);
        $this->assertEqualsWithDelta(now()->getTimestamp(), $stamps[1], 5);
        $this->assertSame(1_780_000_000, $stamps[2], 'epoch milliseconds are understood too');
    }

    // ---- chat ids ----------------------------------------------------------------------------------------------------------

    public function test_the_two_id_dialects_of_one_customer_are_one_chat(): void
    {
        $this->deliver($this->session, $this->messageReceived(['from' => '4915123456789@c.us', 'chatId' => '4915123456789@c.us']))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['from' => '4915123456789@s.whatsapp.net', 'chatId' => '4915123456789@s.whatsapp.net']))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['from' => '4915123456789:12@s.whatsapp.net', 'chatId' => '4915123456789:12@s.whatsapp.net']))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertSame('4915123456789@c.us', $chat->chat_id);
        $this->assertSame(3, $chat->unread_by_admin);
    }

    public function test_the_chat_is_taken_from_from_when_the_message_has_no_chat_id(): void
    {
        $body = $this->messageReceived();
        unset($body['data']['chatId']);

        $this->deliver($this->session, $body)->assertOk();

        $this->assertSame('4915123456789@c.us', WaChat::query()->sole()->chat_id);
    }

    public function test_a_privacy_id_is_a_chat_whose_number_comes_from_sender_phone(): void
    {
        $lid = '98765432101234@lid';

        $this->deliver($this->session, $this->messageReceived(['from' => $lid, 'chatId' => $lid, 'senderPhone' => '4915123456789']))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertSame($lid, $chat->chat_id, 'replies go to the id WhatsApp gave us');
        $this->assertSame('+4915123456789', $chat->phone_e164);
    }

    public function test_a_privacy_id_without_a_number_has_none_and_never_a_made_up_one(): void
    {
        $lid = '98765432101234@lid';

        $this->deliver($this->session, $this->messageReceived(['from' => $lid, 'chatId' => $lid]))->assertOk();
        $this->assertNull(WaChat::query()->sole()->phone_e164);

        // The number turns up in a later message: it is filled in once.
        $this->deliver($this->session, $this->messageReceived(['from' => $lid, 'chatId' => $lid, 'senderPhone' => '4915123456789']))->assertOk();
        $this->assertSame('+4915123456789', WaChat::query()->sole()->phone_e164);
    }

    public function test_groups_are_ignored_by_default_and_recorded_when_the_setting_is_off(): void
    {
        $group = ['from' => '120363023456789012@g.us', 'chatId' => '120363023456789012@g.us', 'isGroup' => true, 'kind' => 'group', 'author' => '4915123456789@c.us'];

        $this->deliver($this->session, $this->messageReceived($group))->assertOk();
        $this->assertSame(0, WaChat::query()->count());
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);

        settings()->set('whatsapp.ignore_groups', false);
        $this->deliver($this->session, $this->messageReceived($group))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertTrue($chat->is_group);
        $this->assertNull($chat->phone_e164);
    }

    /**
     * @return iterable<string, array<string, mixed>>
     */
    public static function notPeople(): iterable
    {
        yield 'a story' => [['from' => 'status@broadcast', 'chatId' => 'status@broadcast', 'kind' => 'status']];
        yield 'a channel' => [['from' => '120363111111111111@newsletter', 'chatId' => '120363111111111111@newsletter', 'kind' => 'channel']];
        yield 'a broadcast list' => [['from' => '1700000000@broadcast', 'chatId' => '1700000000@broadcast', 'kind' => 'broadcast']];
        yield 'a person whose kind says status' => [['kind' => 'status']];
        yield 'an id of unknown shape' => [['from' => 'something-else', 'chatId' => 'something-else', 'kind' => 'unknown']];
    }

    /**
     * @param  array<string, mixed>  $data
     */
    #[DataProvider('notPeople')]
    public function test_only_a_person_becomes_a_chat(array $data): void
    {
        $this->deliver($this->session, $this->messageReceived($data))->assertOk();

        $this->assertSame(0, WaChat::query()->count());
        $this->assertSame(0, WaMessage::query()->count());
        $this->assertSame(WebhookOutcome::Ignored, WaWebhookDelivery::query()->sole()->outcome);
    }

    public function test_the_same_customer_in_two_sessions_is_two_chats(): void
    {
        $other = $this->webhookSession('the-other-sessions-secret-of-forty-chars-02');

        $this->deliver($this->session, $this->messageReceived())->assertOk();
        $this->deliver($other, $this->messageReceived())->assertOk();

        $this->assertSame(2, WaChat::query()->count());
    }

    // ---- the phone's own sends ---------------------------------------------------------------------------------------------

    public function test_a_message_from_the_phone_itself_is_outbound_with_no_unread_and_does_not_start_a_customer_chat(): void
    {
        Event::fake([WaMessageSent::class, WaMessageReceived::class]);

        $this->deliver($this->session, $this->envelope('message.sent', [
            'id' => 'true_4915123456789@c.us_PHONE1', 'from' => '6281234567890@c.us', 'to' => '4915123456789@c.us', 'chatId' => '4915123456789@c.us',
            'body' => 'Sent from the phone', 'type' => 'text', 'timestamp' => now()->getTimestamp(), 'kind' => 'individual', 'fromMe' => true,
            'contact' => ['pushName' => 'Our own name'],
        ]))->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertSame(0, $chat->unread_by_admin);
        $this->assertFalse($chat->inbound_initiated, 'the customer did not write first');
        $this->assertNull($chat->push_name, 'the sender of a fromMe message is us, not the customer');
        $this->assertNull($chat->last_inbound_at);
        $this->assertSame('Sent from the phone', $chat->last_message_preview);

        $message = WaMessage::query()->sole();
        $this->assertSame(WaDirection::Out, $message->direction);
        $this->assertSame(WaMessageStatus::Sent, $message->status);
        $this->assertNull($message->sent_by_user_id);
        Event::assertDispatched(WaMessageSent::class);
        Event::assertNotDispatched(WaMessageReceived::class);
    }

    public function test_a_received_event_flagged_from_me_is_treated_the_same(): void
    {
        $this->deliver($this->session, $this->messageReceived(['fromMe' => true, 'from' => '6281234567890@c.us', 'to' => self::CUSTOMER, 'chatId' => self::CUSTOMER]))->assertOk();

        $this->assertSame(WaDirection::Out, WaMessage::query()->sole()->direction);
        $this->assertSame(0, WaChat::query()->sole()->unread_by_admin);
    }

    public function test_the_customers_reply_after_a_phone_started_chat_does_not_make_it_inbound_initiated(): void
    {
        $this->deliver($this->session, $this->messageReceived(['fromMe' => true, 'from' => '6281234567890@c.us', 'to' => self::CUSTOMER, 'chatId' => self::CUSTOMER]))->assertOk();
        $this->deliver($this->session, $this->messageReceived())->assertOk();

        $chat = WaChat::query()->sole();
        $this->assertFalse($chat->inbound_initiated);
        $this->assertSame(1, $chat->unread_by_admin);
    }

    public function test_the_echo_of_a_reply_the_app_stored_is_not_a_second_message(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => self::CUSTOMER, 'phone_e164' => '+4915123456789']);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound()->pending()->create(['body' => 'We are on it', 'sent_by_user_id' => null]);
        Event::fake([WaMessageStatusChanged::class]);

        // OpenWA's `message.sent` overtakes the send job that would have stored the id: the pending reply adopts it.
        $this->deliver($this->session, $this->envelope('message.sent', [
            'id' => 'true_4915123456789@c.us_ECHO1', 'chatId' => self::CUSTOMER, 'from' => '6281234567890@c.us', 'to' => self::CUSTOMER, 'body' => 'We are on it',
            'type' => 'text', 'timestamp' => now()->getTimestamp(), 'kind' => 'individual', 'fromMe' => true,
        ]))->assertOk();

        $this->assertSame(1, WaMessage::query()->count());
        $reply->refresh();
        $this->assertSame('true_4915123456789@c.us_ECHO1', $reply->wa_message_id);
        $this->assertSame(WaMessageStatus::Sent, $reply->status);
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->from === WaMessageStatus::Pending && $event->message->is($reply));
    }

    public function test_the_echo_of_a_reply_that_already_has_its_id_is_a_duplicate(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create(['chat_id' => self::CUSTOMER]);
        WaMessage::factory()->for($chat, 'chat')->outbound()->create(['body' => 'We are on it', 'wa_message_id' => 'true_4915123456789@c.us_ECHO2']);

        $this->deliver($this->session, $this->envelope('message.sent', [
            'id' => 'true_4915123456789@c.us_ECHO2', 'chatId' => self::CUSTOMER, 'body' => 'We are on it', 'type' => 'text', 'kind' => 'individual', 'fromMe' => true,
        ]))->assertOk();

        $this->assertSame(1, WaMessage::query()->count());
        $this->assertSame(WebhookOutcome::Duplicate, WaWebhookDelivery::query()->sole()->outcome);
    }

    // ---- inbox state -------------------------------------------------------------------------------------------------------

    public function test_a_new_inbound_message_reopens_an_archived_chat_but_a_phone_message_does_not(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->archived()->create(['chat_id' => self::CUSTOMER]);

        $this->deliver($this->session, $this->messageReceived(['fromMe' => true, 'from' => '6281234567890@c.us', 'to' => self::CUSTOMER, 'chatId' => self::CUSTOMER]))->assertOk();
        $this->assertSame(WaChatStatus::Archived, $chat->refresh()->status);

        $this->deliver($this->session, $this->messageReceived())->assertOk();
        $this->assertSame(WaChatStatus::Open, $chat->refresh()->status);
    }

    // ---- media -------------------------------------------------------------------------------------------------------------

    public function test_an_inline_image_is_re_encoded_and_stored_on_the_private_disk_under_a_random_path(): void
    {
        $original = Images::jpegWithExif(64, 48);
        $this->assertStringContainsString('Exif', $original);

        $this->deliver($this->session, $this->messageReceived([
            'type' => 'image', 'body' => 'my receipt',
            'media' => ['mimetype' => 'image/jpeg', 'filename' => '../../etc/passwd<script>.jpg', 'data' => base64_encode($original)],
        ]))->assertOk();

        $message = WaMessage::query()->sole();
        $this->assertSame(WaMessageType::Image, $message->type);
        $this->assertSame('my receipt', $message->body, 'the caption is the body');
        $this->assertTrue($message->hasStoredMedia());
        $this->assertMatchesRegularExpression('#^whatsapp/media/\d{4}/\d{2}/[a-z0-9]{40}\.jpg$#', $message->media_path);
        $this->assertSame('image/jpeg', $message->media_mime);
        $this->assertSame('passwdscript.jpg', $message->media_filename, 'the sender never names a path, and markup characters are dropped');

        $stored = Storage::disk('local')->get($message->media_path);
        $this->assertStringNotContainsString('Exif', $stored, 'the EXIF block did not survive the re-encode');
        $this->assertNotSame($original, $stored);
        $this->assertSame(strlen($stored), $message->media_size);
        $this->assertSame([64, 48], array_slice((array) getimagesizefromstring($stored), 0, 2));
        $this->assertStringNotContainsString('base64', json_encode($message->raw), 'the raw object does not keep the inline file');
        $this->assertSame('my receipt', WaChat::query()->sole()->last_message_preview);
    }

    public function test_an_image_without_a_caption_gets_a_label_preview(): void
    {
        $this->deliver($this->session, $this->messageReceived(['type' => 'image', 'body' => '', 'media' => ['mimetype' => 'image/jpeg', 'data' => base64_encode(Images::jpeg(8, 8))]]))->assertOk();

        $this->assertSame('Photo', WaChat::query()->sole()->last_message_preview);
    }

    public function test_something_that_is_not_an_image_is_recorded_as_a_typed_row_without_a_file(): void
    {
        $this->deliver($this->session, $this->messageReceived([
            'type' => 'image',
            'media' => ['mimetype' => 'image/jpeg', 'data' => base64_encode('<html><script>alert(1)</script></html>')],
        ]))->assertOk();

        $message = WaMessage::query()->sole();
        $this->assertFalse($message->hasStoredMedia());
        $this->assertSame(WaMessageType::Image, $message->type);
        $this->assertSame([], Storage::disk('local')->allFiles());
        $this->assertSame(WebhookOutcome::Processed, WaWebhookDelivery::query()->sole()->outcome, 'a bad file never fails the delivery');
    }

    public function test_an_animated_gif_or_an_image_over_the_size_limit_is_not_stored(): void
    {
        settings()->set('whatsapp.media_max_bytes', 10_240);

        $this->deliver($this->session, $this->messageReceived(['type' => 'image', 'media' => ['mimetype' => 'image/jpeg', 'data' => base64_encode(Images::noisyJpeg(300, 300))]]))->assertOk();
        $this->deliver($this->session, $this->messageReceived(['type' => 'image', 'media' => ['mimetype' => 'image/gif', 'data' => base64_encode(Images::animatedGif())]]))->assertOk();

        $this->assertSame(2, WaMessage::query()->count());
        $this->assertSame(0, WaMessage::query()->whereNotNull('media_path')->count());
        $this->assertSame([], Storage::disk('local')->allFiles());
    }

    public function test_an_image_openwa_did_not_inline_is_fetched_by_a_queued_job_and_stored_like_an_inline_one(): void
    {
        $bytes = Images::jpeg(32, 32);
        $this->openWa()->will('downloadMedia', new OpenWaMedia($bytes, 'image/jpeg', 'photo.jpg'));
        Event::fake([WaMessageStatusChanged::class]);

        $this->deliver($this->session, $this->messageReceived([
            'id' => 'false_4915123456789@c.us_BIG', 'type' => 'image', 'media' => ['mimetype' => 'image/jpeg', 'omitted' => true, 'sizeBytes' => 2_400_000],
        ]))->assertOk();

        $message = WaMessage::query()->sole();
        $this->assertTrue($message->hasStoredMedia());
        $this->assertSame('photo.jpg', $message->media_filename);
        $this->openWa()->assertCalled('downloadMedia', fn (array $args): bool => $args['messageId'] === 'false_4915123456789@c.us_BIG' && $args['chatId'] === '4915123456789@c.us' && $args['sessionId'] === $this->session->openwa_session_id, 1);
        Event::assertDispatched(WaMessageStatusChanged::class, fn (WaMessageStatusChanged $event): bool => $event->from === $event->message->status, 1);
    }

    public function test_the_fetch_uses_the_chat_id_exactly_as_openwa_reported_it(): void
    {
        $this->openWa()->will('downloadMedia', null);

        $this->deliver($this->session, $this->messageReceived([
            'type' => 'image', 'from' => '4915123456789@s.whatsapp.net', 'chatId' => '4915123456789@s.whatsapp.net', 'media' => ['omitted' => true],
        ]))->assertOk();

        $this->openWa()->assertCalled('downloadMedia', fn (array $args): bool => $args['chatId'] === '4915123456789@s.whatsapp.net');
        $this->assertFalse(WaMessage::query()->sole()->hasStoredMedia(), 'nothing stored at OpenWA: a typed row');
    }

    public function test_fetching_is_queued_not_done_inside_the_webhook_when_a_queue_is_used(): void
    {
        Queue::fake();

        $this->deliver($this->session, $this->messageReceived(['type' => 'image', 'media' => ['omitted' => true, 'sizeBytes' => 2_000_000]]));
        $this->assertSame(1, WaWebhookDelivery::query()->count());

        Queue::assertPushed(ProcessWebhookDelivery::class);
    }

    public function test_other_media_types_keep_file_name_type_and_size_and_no_file(): void
    {
        $this->deliver($this->session, $this->messageReceived([
            'type' => 'document', 'body' => null, 'media' => ['mimetype' => 'application/pdf', 'filename' => 'invoice.pdf', 'sizeBytes' => 120_400, 'omitted' => true],
        ]))->assertOk();

        $this->deliver($this->session, $this->messageReceived([
            'type' => 'voice', 'body' => null, 'media' => ['mimetype' => 'audio/ogg; codecs=opus', 'data' => base64_encode('OggS....')],
        ]))->assertOk();

        $messages = WaMessage::query()->orderBy('id')->get();
        $this->assertSame('invoice.pdf', $messages[0]->media_filename);
        $this->assertSame('application/pdf', $messages[0]->media_mime);
        $this->assertSame(120_400, $messages[0]->media_size);
        $this->assertSame('audio/ogg; codecs=opus', $messages[1]->media_mime);
        $this->assertFalse($messages[0]->hasStoredMedia() || $messages[1]->hasStoredMedia());
        $this->assertSame('Voice message', WaChat::query()->sole()->last_message_preview);
        $this->openWa()->assertNotCalled('downloadMedia');
        $this->assertSame([], Storage::disk('local')->allFiles());
    }

    public function test_the_fetch_job_survives_an_openwa_that_is_down_and_gives_up_after_its_tries(): void
    {
        $chat = WaChat::factory()->for($this->session, 'session')->create();
        $message = WaMessage::factory()->for($chat, 'chat')->create(['type' => 'image', 'wa_message_id' => 'false_x_1']);
        $this->openWa()->willThrow('downloadMedia', new OpenWaUnavailable('down'), 3);

        $job = new FetchInboundMedia($message->id);

        try {
            $job->handle($this->openWa(), app(WaMediaStore::class));
            $this->fail('the first attempt should ask the queue to retry');
        } catch (OpenWaUnavailable) {
            $this->assertTrue(true);
        }
    }
}
