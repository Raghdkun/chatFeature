<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Database\Factories\WhatsAppSessionFactory;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class WhatsAppSessionModelTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_new_session_is_created_and_not_connected(): void
    {
        $session = WhatsAppSession::factory()->create()->fresh();

        $this->assertNotNull($session);
        $this->assertSame(SessionStatus::Created, $session->status);
        $this->assertSame('whatsapp-web.js', $session->engine);
        $this->assertNull($session->phone_e164);
        $this->assertFalse($session->isUsable());
        $this->assertFalse($session->hasQr());
        $this->assertFalse($session->isWebhookRegistered());
        $this->assertNull($session->webhook_secret);
        $this->assertSame(26, strlen($session->ulid));
    }

    public function test_the_factory_states_follow_the_status_machine(): void
    {
        $ready = WhatsAppSession::factory()->ready('+4915112345678')->create();
        $this->assertSame(SessionStatus::Ready, $ready->status);
        $this->assertTrue($ready->isUsable());
        $this->assertSame('+4915112345678', $ready->phone_e164);
        $this->assertNotNull($ready->ready_at);
        $this->assertTrue($ready->isWebhookRegistered());
        $this->assertNotNull($ready->webhook_secret);
        $this->assertNotNull($ready->openwa_webhook_id);

        $qr = WhatsAppSession::factory()->qr()->create();
        $this->assertSame(SessionStatus::Qr, $qr->status);
        $this->assertTrue($qr->hasQr());
        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $qr->last_qr);
        $this->assertNotNull($qr->last_qr_at);

        $this->assertSame(SessionStatus::Starting, WhatsAppSession::factory()->starting()->create()->status);

        $disconnected = WhatsAppSession::factory()->disconnected()->create();
        $this->assertSame(SessionStatus::Disconnected, $disconnected->status);
        $this->assertFalse($disconnected->isUsable());
        $this->assertNotNull($disconnected->last_error);

        $failed = WhatsAppSession::factory()->failed('boom')->create();
        $this->assertSame(SessionStatus::Failed, $failed->status);
        $this->assertSame('boom', $failed->last_error);
    }

    public function test_a_qr_is_only_available_while_the_session_waits_for_a_scan(): void
    {
        $session = WhatsAppSession::factory()->qr()->create();
        $this->assertTrue($session->hasQr());

        $session->status = SessionStatus::Ready;
        $this->assertFalse($session->hasQr(), 'paired: the old image is no longer offered');
    }

    public function test_the_session_exposes_its_transition_rule(): void
    {
        $session = WhatsAppSession::factory()->make(['status' => SessionStatus::Created]);

        $this->assertTrue($session->canTransitionTo(SessionStatus::Starting));
        $this->assertFalse($session->canTransitionTo(SessionStatus::Ready));
    }

    public function test_the_webhook_secret_and_the_qr_are_encrypted_at_rest_and_never_serialised(): void
    {
        $session = WhatsAppSession::factory()->qr()->create(['webhook_secret' => 'a-very-secret-signing-key-0123456789']);

        $row = DB::table('whatsapp_sessions')->where('id', $session->id)->first();
        $this->assertNotNull($row);
        $this->assertStringNotContainsString('a-very-secret-signing-key', (string) $row->webhook_secret_encrypted);
        $this->assertStringNotContainsString('a-very-secret-signing-key', (string) json_encode($row));
        $this->assertStringNotContainsString('iVBORw0KGgo', (string) $row->last_qr, 'the QR image is stored encrypted');

        $fresh = WhatsAppSession::query()->findOrFail($session->id);
        $this->assertSame('a-very-secret-signing-key-0123456789', $fresh->webhook_secret);
        $this->assertSame(WhatsAppSessionFactory::FAKE_QR, $fresh->last_qr);

        $json = json_encode($fresh->toArray(), JSON_THROW_ON_ERROR);
        $this->assertStringNotContainsString('a-very-secret-signing-key', $json);
        $this->assertStringNotContainsString('webhook_secret', $json);
        $this->assertStringNotContainsString('last_qr"', $json);
        $this->assertStringNotContainsString('iVBORw0KGgo', $json);
    }

    public function test_a_secret_that_cannot_be_decrypted_reads_as_missing(): void
    {
        $session = WhatsAppSession::factory()->withWebhook()->create();
        DB::table('whatsapp_sessions')->where('id', $session->id)->update(['webhook_secret_encrypted' => 'garbage-ciphertext']);

        $fresh = WhatsAppSession::query()->findOrFail($session->id);

        $this->assertTrue($fresh->hasWebhookSecret());
        $this->assertNull($fresh->webhook_secret);
    }

    public function test_the_secret_can_be_cleared(): void
    {
        $session = WhatsAppSession::factory()->withWebhook()->create();

        $session->webhook_secret = null;
        $session->save();

        $this->assertFalse($session->fresh()?->hasWebhookSecret());
    }

    public function test_the_webhook_url_is_built_on_the_configured_origin_not_the_request_host(): void
    {
        settings()->set('app.url', 'https://chat.example.com/some/path');
        $session = WhatsAppSession::factory()->create();

        $this->assertSame('https://chat.example.com/webhooks/openwa/'.$session->ulid, $session->webhookUrl());

        $this->get('/', ['Host' => 'evil.test']);
        $this->assertStringStartsWith('https://chat.example.com/', $session->webhookUrl());
    }

    public function test_the_phone_is_masked_for_display(): void
    {
        $this->assertSame('+49•••••••6789', WhatsAppSession::factory()->make(['phone_e164' => '+4915123456789'])->maskedPhone());
        $this->assertNull(WhatsAppSession::factory()->make(['phone_e164' => null])->maskedPhone());
    }

    public function test_pacing_comes_from_the_settings_unless_the_session_overrides_it(): void
    {
        $plain = WhatsAppSession::factory()->create();
        $this->assertSame(1500, $plain->sendMinIntervalMs());
        $this->assertSame(200, $plain->dailySendCap());

        settings()->set('whatsapp.send_min_interval_ms', 2500);
        settings()->set('whatsapp.daily_send_cap', 50);
        $this->assertSame(2500, $plain->sendMinIntervalMs());
        $this->assertSame(50, $plain->dailySendCap());

        $custom = WhatsAppSession::factory()->withPacing(sendMinIntervalMs: 4000)->create();
        $this->assertSame(4000, $custom->sendMinIntervalMs());
        $this->assertSame(50, $custom->dailySendCap(), 'only what is overridden changes');

        $both = WhatsAppSession::factory()->withPacing(0, 10)->create();
        $this->assertSame(0, $both->sendMinIntervalMs(), 'zero is a real override');
        $this->assertSame(10, $both->dailySendCap());

        $junk = WhatsAppSession::factory()->create(['settings' => ['send_min_interval_ms' => 'soon', 'daily_send_cap' => -5]]);
        $this->assertSame(2500, $junk->sendMinIntervalMs());
        $this->assertSame(0, $junk->dailySendCap(), 'a negative override is clamped, never a negative cap');
    }

    public function test_session_names_follow_openwas_rules(): void
    {
        foreach (['abc', 'support-main', 'A1-b2', str_repeat('a', 50)] as $name) {
            $this->assertSame(1, preg_match(WhatsAppSession::NAME_PATTERN, $name), $name);
        }

        foreach (['ab', 'with space', 'under_score', str_repeat('a', 51), 'ünï', ''] as $name) {
            $this->assertSame(0, preg_match(WhatsAppSession::NAME_PATTERN, $name), $name);
        }
    }

    public function test_the_session_knows_its_widgets_chats_tickets_and_deliveries(): void
    {
        $session = WhatsAppSession::factory()->ready()->create();
        Widget::factory()->count(2)->withWhatsAppSession($session)->create();
        Widget::factory()->create();
        WaChat::factory()->count(3)->create(['session_id' => $session->id]);
        WaHandoffTicket::factory()->create(['session_id' => $session->id]);
        WaWebhookDelivery::factory()->count(2)->create(['session_id' => $session->id]);

        $this->assertSame(2, $session->widgets()->count());
        $this->assertSame(3, $session->chats()->count());
        $this->assertSame(1, $session->handoffTickets()->count());
        $this->assertSame(2, $session->webhookDeliveries()->count());
        $this->assertTrue(Widget::query()->where('whatsapp_session_id', $session->id)->first()?->whatsappSession?->is($session));
    }

    public function test_the_route_key_is_the_ulid(): void
    {
        $session = WhatsAppSession::factory()->create();

        $this->assertSame('ulid', $session->getRouteKeyName());
        $this->assertTrue(WhatsAppSession::query()->where('ulid', $session->ulid)->firstOrFail()->is($session));
    }
}
