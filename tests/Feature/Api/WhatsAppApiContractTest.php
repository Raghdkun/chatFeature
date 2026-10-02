<?php

namespace Tests\Feature\Api;

use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Sleep;
use Illuminate\Testing\TestResponse;
use Tests\Support\AssertsOpenApi;
use Tests\Support\Images;
use Tests\Support\OpenWaWebhooks;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The administrator-only WhatsApp surface and the inbound OpenWA webhook against the committed OpenAPI file ({@see AssertsOpenApi}),
 * including the documented fact that an agent gets `403` and nothing else.
 */
class WhatsAppApiContractTest extends TestCase
{
    use AssertsOpenApi, OpenWaWebhooks, RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        Storage::fake('local');
        Sleep::fake();
        $this->admin = $this->whatsAppPeople()['admin'];
    }

    private function api(?User $user = null): static
    {
        $this->app['auth']->forgetGuards();

        return $this->flushHeaders()->actingAs($user ?? $this->admin, 'sanctum');
    }

    private function contract(TestResponse $response, string $method, string $path): TestResponse
    {
        $this->assertMatchesOpenApi($response, ApiAudience::Management, $method, $path);

        return $response;
    }

    public function test_sessions_and_settings_match_the_reference(): void
    {
        Queue::fake();

        $created = $this->contract($this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main']), 'POST', '/api/v1/whatsapp/sessions')->assertCreated();
        $ulid = (string) $created->json('data.ulid');
        $this->contract($this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'support-main']), 'POST', '/api/v1/whatsapp/sessions')->assertStatus(409)->assertJsonPath('error.code', 'session_name_taken');
        $this->contract($this->api()->postJson('/api/v1/whatsapp/sessions', ['name' => 'x']), 'POST', '/api/v1/whatsapp/sessions')->assertStatus(422);

        $this->contract($this->api()->getJson('/api/v1/whatsapp/sessions'), 'GET', '/api/v1/whatsapp/sessions')->assertOk();
        $this->contract($this->api()->getJson('/api/v1/whatsapp/sessions/'.$ulid), 'GET', '/api/v1/whatsapp/sessions/{session}')->assertOk();
        $this->contract($this->api()->patchJson('/api/v1/whatsapp/sessions/'.$ulid, ['daily_send_cap' => 100, 'send_min_interval_ms' => null]), 'PATCH', '/api/v1/whatsapp/sessions/{session}')->assertOk();
        $this->contract($this->api()->postJson('/api/v1/whatsapp/sessions/'.$ulid.'/start'), 'POST', '/api/v1/whatsapp/sessions/{session}/start')->assertStatus(202);
        $this->contract($this->api()->getJson('/api/v1/whatsapp/sessions/'.$ulid.'/qr'), 'GET', '/api/v1/whatsapp/sessions/{session}/qr')->assertStatus(409)->assertJsonPath('error.code', 'qr_not_available');
        $this->contract($this->api()->postJson('/api/v1/whatsapp/sessions/'.$ulid.'/sync'), 'POST', '/api/v1/whatsapp/sessions/{session}/sync')->assertOk();

        $this->contract($this->api()->getJson('/api/v1/whatsapp/settings'), 'GET', '/api/v1/whatsapp/settings')->assertOk();
        $this->contract($this->api()->putJson('/api/v1/whatsapp/settings', ['enabled' => true, 'handoff_text' => 'Hi, my code is :code']), 'PUT', '/api/v1/whatsapp/settings')->assertOk();
        $this->contract($this->api()->putJson('/api/v1/whatsapp/settings', ['handoff_text' => 'no code here']), 'PUT', '/api/v1/whatsapp/settings')->assertStatus(422);
        $this->contract($this->api()->postJson('/api/v1/whatsapp/settings/test'), 'POST', '/api/v1/whatsapp/settings/test')->assertOk();
    }

    public function test_the_inbox_matches_the_reference(): void
    {
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $chat = WaChat::factory()->for($session, 'session')->unread(2)->create();
        WaMessage::factory()->for($chat, 'chat')->inbound()->create(['body' => 'Hello']);
        $reply = WaMessage::factory()->for($chat, 'chat')->outbound($this->admin)->delivered()->create(['body' => 'Hi!']);

        $list = $this->contract($this->api()->getJson('/api/v1/whatsapp/chats'), 'GET', '/api/v1/whatsapp/chats')->assertOk();
        $this->assertSame(1, $list->json('meta.unread_chats'));
        $this->contract($this->api()->getJson('/api/v1/whatsapp/chats?cursor=bogus'), 'GET', '/api/v1/whatsapp/chats')->assertStatus(422);
        $this->contract($this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid), 'GET', '/api/v1/whatsapp/chats/{chat}')->assertOk();
        $this->contract($this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages'), 'GET', '/api/v1/whatsapp/chats/{chat}/messages')->assertOk();
        $this->contract($this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages?after_id='.$reply->ulid), 'GET', '/api/v1/whatsapp/chats/{chat}/messages')->assertOk();
        $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/read'), 'POST', '/api/v1/whatsapp/chats/{chat}/read')->assertOk();
        $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/archive'), 'POST', '/api/v1/whatsapp/chats/{chat}/archive')->assertOk();
        $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/unarchive'), 'POST', '/api/v1/whatsapp/chats/{chat}/unarchive')->assertOk();

        $csv = $this->api()->get('/api/v1/whatsapp/export?format=csv')->assertOk();
        $this->contract($csv, 'GET', '/api/v1/whatsapp/export');
        $this->assertStringContainsString('attachment', (string) $csv->headers->get('Content-Disposition'));

        $this->contract($this->api()->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid), 'DELETE', '/api/v1/whatsapp/chats/{chat}')->assertNoContent();
        $this->contract($this->api()->deleteJson('/api/v1/whatsapp/chats/'.$chat->ulid), 'DELETE', '/api/v1/whatsapp/chats/{chat}')->assertNoContent();
    }

    public function test_a_reply_and_the_widget_link_match_the_reference(): void
    {
        $session = WhatsAppSession::factory()->ready()->create(['name' => 'support-main']);
        $chat = WaChat::factory()->for($session, 'session')->create(['inbound_initiated' => true]);
        Queue::fake();

        $sent = $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'On it.', 'client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w4']), 'POST', '/api/v1/whatsapp/chats/{chat}/messages')->assertCreated();
        $this->assertSame('pending', $sent->json('data.status'));
        $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => 'On it.', 'client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w4']), 'POST', '/api/v1/whatsapp/chats/{chat}/messages')->assertOk();
        $this->contract($this->api()->postJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages', ['body' => '']), 'POST', '/api/v1/whatsapp/chats/{chat}/messages')->assertStatus(422);

        $widget = $this->enabledWidget();
        $this->contract($this->api()->getJson('/api/v1/widgets/'.$widget->ulid.'/whatsapp'), 'GET', '/api/v1/widgets/{widget}/whatsapp')->assertOk();
        $this->contract($this->api()->putJson('/api/v1/widgets/'.$widget->ulid.'/whatsapp', ['session' => $session->ulid]), 'PUT', '/api/v1/widgets/{widget}/whatsapp')->assertOk();
        $this->contract($this->api()->putJson('/api/v1/widgets/'.$widget->ulid.'/whatsapp', ['session' => '01j9z3q8x7m5n2k4p6r8t0v1w2']), 'PUT', '/api/v1/widgets/{widget}/whatsapp')->assertStatus(422);
    }

    public function test_a_stored_image_is_fetched_with_a_signed_url_by_an_administrator(): void
    {
        $this->app->instance(WaMediaUrls::class, $this->app->make(SignedWaMediaUrls::class));
        $chat = WaChat::factory()->for(WhatsAppSession::factory()->ready(), 'session')->create();
        Storage::disk('local')->put('whatsapp/media/2026/10/abc.jpg', Images::jpeg(20, 10));
        $message = WaMessage::factory()->for($chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/abc.jpg', 'media_mime' => 'image/jpeg']);

        $url = $this->api()->getJson('/api/v1/whatsapp/chats/'.$chat->ulid.'/messages')->json('data.0.media.url');
        $this->contract($this->api()->get((string) $url), 'GET', '/api/v1/whatsapp/media/{message}')->assertOk();
        $this->contract($this->api()->getJson('/api/v1/whatsapp/media/'.$message->ulid), 'GET', '/api/v1/whatsapp/media/{message}')->assertForbidden();
    }

    public function test_an_agent_gets_only_the_documented_403(): void
    {
        $agent = $this->whatsAppPeople()['agent'];

        $this->contract($this->api($agent)->getJson('/api/v1/whatsapp/sessions'), 'GET', '/api/v1/whatsapp/sessions')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->contract($this->api($agent)->getJson('/api/v1/whatsapp/chats'), 'GET', '/api/v1/whatsapp/chats')->assertForbidden();
    }

    public function test_the_inbound_webhook_matches_the_reference(): void
    {
        $session = $this->webhookSession();

        $this->contract($this->deliver($session, ['event' => 'something.unhandled', 'sessionId' => $session->openwa_session_id]), 'POST', '/webhooks/openwa/{session}')->assertOk()->assertJsonPath('status', 'accepted');
        $this->contract($this->deliver($session, ['event' => 'something.unhandled'], secret: 'wrong-secret'), 'POST', '/webhooks/openwa/{session}')->assertUnauthorized();
        $this->contract($this->deliver($session, ['nothing' => 'here']), 'POST', '/webhooks/openwa/{session}')->assertStatus(400)->assertJsonPath('error.code', 'invalid_webhook');
    }
}
