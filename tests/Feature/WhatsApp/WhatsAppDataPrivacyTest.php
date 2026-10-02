<?php

namespace Tests\Feature\WhatsApp;

use App\Data\WhatsApp\Events\WaChatUpdatedPayload;
use App\Data\WhatsApp\Events\WaMessageCreatedPayload;
use App\Data\WhatsApp\Events\WaMessageUpdatedPayload;
use App\Data\WhatsApp\Events\WaSessionStatusPayload;
use App\Data\WhatsApp\HandoffData;
use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaChatDetailData;
use App\Data\WhatsApp\WaMessageData;
use App\Data\WhatsApp\WhatsAppSessionData;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Spatie\LaravelData\Data;
use Tests\TestCase;

/**
 * What must never reach a client, whichever Data class carries the row: the webhook secret, the OpenWA API key, the OpenWA ids, the
 * QR image, the storage path of a file, the raw webhook object and the WhatsApp ids. Every sentinel below is planted in a row the
 * classes are built from.
 */
class WhatsAppDataPrivacyTest extends TestCase
{
    use RefreshDatabase;

    private const SECRET = 'SENTINEL-WEBHOOK-SECRET-0123456789';

    private const API_KEY = 'owa_k1_SENTINEL-API-KEY';

    private const OPENWA_SESSION = 'SENTINEL-OPENWA-SESSION-ID';

    private const OPENWA_WEBHOOK = 'SENTINEL-OPENWA-WEBHOOK-ID';

    private const STORAGE_PATH = 'whatsapp/media/SENTINEL-STORAGE-PATH.jpg';

    private const RAW = 'SENTINEL-RAW-PAYLOAD';

    private const WA_MESSAGE_ID = 'SENTINEL-WA-MESSAGE-ID';

    private const CHAT_ID = '4915100099999@c.us';

    private const QR_MARKER = 'iVBORw0KGgo';

    /** @var list<string> */
    private const FORBIDDEN_VALUES = [
        self::SECRET, self::API_KEY, self::OPENWA_SESSION, self::OPENWA_WEBHOOK, self::STORAGE_PATH, self::RAW, self::WA_MESSAGE_ID, self::CHAT_ID, self::QR_MARKER,
    ];

    /** @var list<string> */
    private const FORBIDDEN_KEYS = [
        'webhookSecret', 'webhook_secret', 'webhook_secret_encrypted', 'apiKey', 'api_key', 'lastQr', 'last_qr', 'qrCode', 'openwaSessionId', 'openwa_session_id',
        'openwaWebhookId', 'openwa_webhook_id', 'path', 'mediaPath', 'media_path', 'disk', 'raw', 'waMessageId', 'wa_message_id', 'chatId', 'chat_id',
        'settings', 'workspaceId', 'workspace_id', 'externalId', 'external_id', 'meta',
    ];

    /**
     * @return list<Data>
     */
    private function everyData(): array
    {
        settings()->set('whatsapp.openwa.api_key', self::API_KEY);

        $session = WhatsAppSession::factory()->qr()->create([
            'openwa_session_id' => self::OPENWA_SESSION,
            'openwa_webhook_id' => self::OPENWA_WEBHOOK,
            'phone_e164' => '+4915100000001',
            'webhook_secret' => self::SECRET,
            'settings' => ['send_min_interval_ms' => 2000],
        ]);
        $widget = Widget::factory()->withWhatsAppSession($session)->create();
        $visitor = Visitor::factory()->verified('host-user-42')->create(['widget_id' => $widget->id, 'meta' => ['internal' => 'SENTINEL-META']]);
        $chat = WaChat::factory()->linked($widget, $visitor)->create(['session_id' => $session->id, 'chat_id' => self::CHAT_ID, 'phone_e164' => '+4915100099999']);
        $image = WaMessage::factory()->image()->create(['wa_chat_id' => $chat->id, 'wa_message_id' => self::WA_MESSAGE_ID, 'media_path' => self::STORAGE_PATH, 'raw' => ['data' => self::RAW]]);
        $reply = WaMessage::factory()->outbound()->failed()->create(['wa_chat_id' => $chat->id, 'raw' => ['data' => self::RAW]]);
        $ticket = WaHandoffTicket::factory()->create(['session_id' => $session->id]);

        $chat->load(['session', 'widget', 'category', 'visitor', 'handoffTicket']);
        $image->load(['chat', 'sentBy']);
        $reply->load(['chat', 'sentBy']);
        $sessionData = WhatsAppSessionData::fromModel($session);
        $chatData = WaChatData::fromModel($chat);

        return [
            $sessionData,
            $chatData,
            WaChatDetailData::fromModel($chat),
            WaMessageData::fromModel($image),
            WaMessageData::fromModel($reply),
            HandoffData::fromTicket($ticket->load('session')),
            new WaMessageCreatedPayload(WaMessageData::fromModel($image), $chatData),
            new WaMessageUpdatedPayload(WaMessageData::fromModel($reply)),
            new WaChatUpdatedPayload($chatData),
            new WaSessionStatusPayload($sessionData),
        ];
    }

    /**
     * @param  array<array-key, mixed>  $payload
     * @return list<string>
     */
    private function keysOf(array $payload): array
    {
        $keys = [];

        foreach ($payload as $key => $value) {
            if (is_string($key)) {
                $keys[] = $key;
            }

            if (is_array($value)) {
                $keys = [...$keys, ...$this->keysOf($value)];
            }
        }

        return $keys;
    }

    public function test_no_secret_key_id_path_or_raw_payload_appears_in_any_value(): void
    {
        foreach ($this->everyData() as $data) {
            $json = (string) json_encode($data->toArray());

            foreach (self::FORBIDDEN_VALUES as $value) {
                $this->assertStringNotContainsString($value, $json, $data::class.' leaks '.$value);
            }
        }
    }

    public function test_no_forbidden_key_appears_in_any_payload(): void
    {
        foreach ($this->everyData() as $data) {
            $keys = $this->keysOf($data->toArray());

            foreach (self::FORBIDDEN_KEYS as $key) {
                $this->assertNotContains($key, $keys, $data::class." has a [{$key}] key");
            }
        }
    }

    public function test_the_visitor_facing_hand_off_carries_nothing_but_its_three_keys(): void
    {
        $ticket = WaHandoffTicket::factory()->create(['session_id' => WhatsAppSession::factory()->ready()->create(['webhook_secret' => self::SECRET])->id]);

        $json = (string) json_encode(HandoffData::fromTicket($ticket->load('session'))->toArray());

        $this->assertSame(['code', 'waUrl', 'expiresAt'], array_keys(HandoffData::fromTicket($ticket)->toArray()));
        $this->assertStringNotContainsString(self::SECRET, $json);
        $this->assertStringNotContainsString($ticket->ulid, $json, 'not even the ticket id');
        $this->assertStringNotContainsString($ticket->session->ulid, $json);
    }

    public function test_the_api_key_never_comes_out_of_the_settings_list(): void
    {
        settings()->set('whatsapp.openwa.api_key', self::API_KEY);

        $all = settings()->all();

        $this->assertArrayNotHasKey('whatsapp.openwa.api_key', $all);
        $this->assertStringNotContainsString(self::API_KEY, (string) json_encode($all));
    }
}
