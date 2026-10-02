<?php

namespace Tests\Feature\Api;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\AssertsOpenApi;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithRealtime;
use Tests\Support\InteractsWithWhatsAppWidgets;
use Tests\TestCase;

/**
 * The visitor API against its committed OpenAPI file ({@see AssertsOpenApi}): every call of the main flows is made for real and the
 * answer is checked against the schema the reference gives that operation. A field added, removed or retyped without regenerating the
 * reference fails here, and so does an answer the reference does not document (a status, an error envelope).
 *
 * Flows: config and availability, session, start / read / end a chat with an agent on the other side, messages (idempotent replay,
 * receipts, typing, attachments, signed download), rating, cancelling, the offline form, the WhatsApp hand-off, the channel
 * authorisation and the documented error answers.
 */
class PublicApiContractTest extends TestCase
{
    use AssertsOpenApi, ChatFixtures, InteractsWithRealtime, InteractsWithWhatsAppWidgets, RefreshDatabase;

    private Widget $widget;

    private Category $category;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        [$this->widget, $this->category] = $this->chatWidget();
        $this->agent = $this->availableAgent($this->category);
    }

    private function contract(TestResponse $response, string $method, string $path, ApiAudience $audience = ApiAudience::Public): TestResponse
    {
        $this->assertMatchesOpenApi($response, $audience, $method, $path);

        return $response;
    }

    /** A visitor call with the token of an issued session (the test client keeps headers between calls: start from none). */
    private function visitor(string $token): static
    {
        return $this->flushHeaders()->withToken($token);
    }

    /** A call without any credential. */
    private function anonymous(): static
    {
        return $this->flushHeaders();
    }

    /** The staff side of the same chat, through the management API (also checked against its own reference). */
    private function claim(string $conversation): void
    {
        $this->app['auth']->forgetGuards();
        $response = $this->flushHeaders()->actingAs($this->agent)->postJson("/api/v1/conversations/{$conversation}/claim");
        $this->contract($response, 'POST', '/api/v1/conversations/{conversation}/claim', ApiAudience::Management)->assertOk();
        $this->app['auth']->forgetGuards();
        $this->flushSession();
    }

    // ---- widget gate ------------------------------------------------------------------------------------------------------------

    public function test_config_and_availability_match_the_reference_including_not_modified(): void
    {
        $key = $this->widget->public_key;
        $headers = ['Origin' => self::CUSTOMER_ORIGIN];

        $config = $this->flushHeaders()->withHeaders($headers)->getJson("/api/v1/public/widgets/{$key}/config")->assertOk();
        $this->contract($config, 'GET', '/api/v1/public/widgets/{key}/config');

        $this->contract($this->withHeaders($headers)->getJson("/api/v1/public/widgets/{$key}/config?locale=en"), 'GET', '/api/v1/public/widgets/{key}/config')->assertOk();

        $notModified = $this->withHeaders($headers + ['If-None-Match' => (string) $config->headers->get('ETag')])->getJson("/api/v1/public/widgets/{$key}/config")->assertStatus(304);
        $this->contract($notModified, 'GET', '/api/v1/public/widgets/{key}/config');

        $availability = $this->withHeaders($headers)->getJson("/api/v1/public/widgets/{$key}/availability")->assertOk();
        $this->contract($availability, 'GET', '/api/v1/public/widgets/{key}/availability');
        $this->assertTrue($availability->json('data.online'), 'an online agent serves the category');
    }

    public function test_the_gate_errors_use_the_documented_envelope(): void
    {
        $key = $this->widget->public_key;

        $this->contract($this->withHeaders(['Origin' => 'https://evil.test'])->getJson("/api/v1/public/widgets/{$key}/config"), 'GET', '/api/v1/public/widgets/{key}/config')
            ->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed');

        $this->contract($this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->getJson('/api/v1/public/widgets/wk_unknownunknownunknown/config'), 'GET', '/api/v1/public/widgets/{key}/config')
            ->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');

        $this->contract($this->withHeaders(['Origin' => 'https://evil.test'])->postJson("/api/v1/public/widgets/{$key}/sessions"), 'POST', '/api/v1/public/widgets/{key}/sessions')
            ->assertForbidden();

        $this->contract($this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->postJson("/api/v1/public/widgets/{$key}/sessions", ['visitor' => ['email' => 'not-an-email']]), 'POST', '/api/v1/public/widgets/{key}/sessions')
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed')->assertJsonStructure(['error' => ['details' => ['visitor.email']]]);
    }

    // ---- the chat ---------------------------------------------------------------------------------------------------------------

    public function test_a_whole_chat_from_session_to_rating_matches_the_reference(): void
    {
        $key = $this->widget->public_key;
        $origin = ['Origin' => self::CUSTOMER_ORIGIN];

        // Session.
        $session = $this->withHeaders($origin)->postJson("/api/v1/public/widgets/{$key}/sessions", [
            'visitor' => ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'meta' => ['plan' => 'pro']],
            'page' => ['url' => 'https://customer.test/pricing', 'title' => 'Pricing', 'referrer' => ''],
            'locale' => 'en',
        ])->assertCreated();
        $this->contract($session, 'POST', '/api/v1/public/widgets/{key}/sessions');
        $token = (string) $session->json('data.visitorToken');

        // No chat yet; start one.
        $this->contract($this->visitor($token)->getJson('/api/v1/public/conversation'), 'GET', '/api/v1/public/conversation')->assertOk()->assertJsonPath('data', null);

        $started = $this->visitor($token)->postJson('/api/v1/public/conversations', ['category' => 'billing', 'message' => 'Hi, I need help with my invoice.'])->assertCreated();
        $this->contract($started, 'POST', '/api/v1/public/conversations');
        $conversation = (string) $started->json('data.ulid');

        $this->contract($this->visitor($token)->getJson('/api/v1/public/conversation'), 'GET', '/api/v1/public/conversation')->assertOk()->assertJsonPath('data.status', 'queued');

        // Messages are refused until an agent accepts; then they flow.
        $refused = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/messages", ['body' => 'Hello?'])->assertStatus(409);
        $this->contract($refused, 'POST', '/api/v1/public/conversations/{ulid}/messages')->assertJsonPath('error.code', 'conversation_not_active');

        $this->claim($conversation);

        $first = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/messages", ['client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w2', 'body' => 'Are you there?'])->assertCreated();
        $this->contract($first, 'POST', '/api/v1/public/conversations/{ulid}/messages');

        $replay = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/messages", ['client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w2', 'body' => 'Are you there?'])->assertOk();
        $this->contract($replay, 'POST', '/api/v1/public/conversations/{ulid}/messages');
        $this->assertSame($first->json('data.ulid'), $replay->json('data.ulid'));

        // An agent answers (management API), the visitor reads.
        $this->app['auth']->forgetGuards();
        $reply = $this->flushHeaders()->actingAs($this->agent)->postJson("/api/v1/conversations/{$conversation}/messages", ['body' => 'Yes, how can I help?'])->assertCreated();
        $this->contract($reply, 'POST', '/api/v1/conversations/{conversation}/messages', ApiAudience::Management);
        $this->assertArrayHasKey('id', $reply->json('data.sender'), 'staff payloads carry the sender id');
        $this->app['auth']->forgetGuards();
        $this->flushSession();

        $page = $this->visitor($token)->getJson("/api/v1/public/conversations/{$conversation}/messages?after_seq=0")->assertOk();
        $this->contract($page, 'GET', '/api/v1/public/conversations/{ulid}/messages');
        $this->assertNotEmpty($page->json('data'));

        foreach ($page->json('data') as $message) {
            $this->assertArrayNotHasKey('id', $message['sender'], 'a visitor never gets a staff id');
        }

        $lastSeq = (int) collect($page->json('data'))->max('seq');
        $this->contract($this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/receipts", ['delivered_upto' => $lastSeq, 'seen_upto' => $lastSeq]), 'POST', '/api/v1/public/conversations/{ulid}/receipts')->assertNoContent();
        $this->contract($this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/typing", ['typing' => true]), 'POST', '/api/v1/public/conversations/{ulid}/typing')->assertNoContent();

        // An image, referenced by the next message, and its signed download.
        $upload = $this->visitor($token)->post("/api/v1/public/conversations/{$conversation}/attachments", ['file' => $this->pngUpload()], ['Accept' => 'application/json'])->assertCreated();
        $this->contract($upload, 'POST', '/api/v1/public/conversations/{ulid}/attachments');

        $withImage = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/messages", ['attachments' => [$upload->json('data.ulid')]])->assertCreated();
        $this->contract($withImage, 'POST', '/api/v1/public/conversations/{ulid}/messages');
        $this->assertCount(1, $withImage->json('data.attachments'));

        $download = $this->get((string) $withImage->json('data.attachments.0.url'))->assertOk();
        $this->contract($download, 'GET', '/api/v1/public/attachments/{attachment}');
        $this->assertSame('image/png', $download->headers->get('Content-Type'));

        $this->contract($this->get('/api/v1/public/attachments/'.$upload->json('data.ulid').'?signature=forged', ['Accept' => 'application/json']), 'GET', '/api/v1/public/attachments/{attachment}')->assertForbidden();

        // End, rate.
        $ended = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/end")->assertOk();
        $this->contract($ended, 'POST', '/api/v1/public/conversations/{ulid}/end');
        $this->assertTrue($ended->json('data.ratingRequested'));

        $rated = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/rating", ['score' => 5, 'comment' => 'Quick and helpful.'])->assertCreated();
        $this->contract($rated, 'POST', '/api/v1/public/conversations/{ulid}/rating');

        $again = $this->visitor($token)->postJson("/api/v1/public/conversations/{$conversation}/rating", ['score' => 4])->assertStatus(409);
        $this->contract($again, 'POST', '/api/v1/public/conversations/{ulid}/rating')->assertJsonPath('error.code', 'already_rated');

        // Leave.
        $this->contract($this->visitor($token)->deleteJson('/api/v1/public/sessions'), 'DELETE', '/api/v1/public/sessions')->assertNoContent();
        $this->contract($this->visitor($token)->getJson('/api/v1/public/conversation'), 'GET', '/api/v1/public/conversation')->assertUnauthorized()->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_cancelling_skipping_the_rating_and_the_offline_form_match_the_reference(): void
    {
        $issued = $this->visitorSession($this->widget);
        $chat = $this->visitor($issued->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])->assertCreated();
        $conversation = (string) $chat->json('data.ulid');

        $this->contract($this->visitor($issued->plaintext)->postJson("/api/v1/public/conversations/{$conversation}/cancel"), 'POST', '/api/v1/public/conversations/{ulid}/cancel')
            ->assertOk()->assertJsonPath('data.status', 'closed');

        $notQueued = $this->visitor($issued->plaintext)->postJson("/api/v1/public/conversations/{$conversation}/cancel")->assertStatus(409);
        $this->contract($notQueued, 'POST', '/api/v1/public/conversations/{ulid}/cancel')->assertJsonPath('error.code', 'conversation_not_queued');

        // An ended chat can skip its rating.
        $second = $this->visitorSession($this->widget);
        $started = $this->visitor($second->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])->assertCreated();
        $this->claim((string) $started->json('data.ulid'));
        $this->visitor($second->plaintext)->postJson('/api/v1/public/conversations/'.$started->json('data.ulid').'/end')->assertOk();
        $this->contract($this->visitor($second->plaintext)->postJson('/api/v1/public/conversations/'.$started->json('data.ulid').'/rating/skip'), 'POST', '/api/v1/public/conversations/{ulid}/rating/skip')
            ->assertOk()->assertJsonPath('data.status', 'closed');

        // The offline form.
        $ticket = $this->visitor($second->plaintext)->postJson('/api/v1/public/offline-tickets', ['name' => 'Ada Lovelace', 'email' => 'ada@example.com', 'message' => 'Nobody was online.', 'category' => 'billing'])->assertCreated();
        $this->contract($ticket, 'POST', '/api/v1/public/offline-tickets');
        $this->assertSame('offline', $ticket->json('data.type'));

        $this->contract($this->visitor($second->plaintext)->postJson('/api/v1/public/offline-tickets', ['name' => '']), 'POST', '/api/v1/public/offline-tickets')->assertStatus(422);
    }

    public function test_the_visitor_error_answers_match_the_reference(): void
    {
        $issued = $this->visitorSession($this->widget);
        $other = $this->visitorSession($this->widget);
        $chat = $this->visitor($other->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])->assertCreated();
        $conversation = (string) $chat->json('data.ulid');

        // Another visitor's conversation is a 404, never a 403.
        $this->contract($this->visitor($issued->plaintext)->getJson("/api/v1/public/conversations/{$conversation}/messages"), 'GET', '/api/v1/public/conversations/{ulid}/messages')
            ->assertNotFound()->assertJsonPath('error.code', 'not_found');

        $this->contract($this->anonymous()->getJson('/api/v1/public/conversation'), 'GET', '/api/v1/public/conversation')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->contract($this->visitor('vt_'.str_repeat('x', 40))->getJson('/api/v1/public/conversation'), 'GET', '/api/v1/public/conversation')->assertUnauthorized();

        $this->contract($this->visitor($other->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing']), 'POST', '/api/v1/public/conversations')
            ->assertStatus(409)->assertJsonPath('error.code', 'conversation_exists');

        $this->contract($this->visitor($issued->plaintext)->postJson('/api/v1/public/conversations', []), 'POST', '/api/v1/public/conversations')->assertStatus(422);

        // Nobody online: the offline form is the way out.
        $this->setPresence($this->agent, PresenceStatus::Offline);
        $third = $this->visitorSession($this->widget);
        $this->contract($this->visitor($third->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing']), 'POST', '/api/v1/public/conversations')
            ->assertStatus(409)->assertJsonPath('error.code', 'no_agents');
    }

    public function test_the_rate_limit_answer_matches_the_reference(): void
    {
        config(['chat.rate_limits.public_message_session' => 1, 'chat.rate_limits.public_chat_session' => 1000]);
        $issued = $this->visitorSession($this->widget);
        $chat = $this->visitor($issued->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])->assertCreated();
        $this->claim((string) $chat->json('data.ulid'));
        $uri = '/api/v1/public/conversations/'.$chat->json('data.ulid').'/messages';

        $this->visitor($issued->plaintext)->postJson($uri, ['body' => 'one'])->assertCreated();
        $limited = $this->visitor($issued->plaintext)->postJson($uri, ['body' => 'two'])->assertStatus(429);

        $this->contract($limited, 'POST', '/api/v1/public/conversations/{ulid}/messages')->assertJsonPath('error.code', 'rate_limited');
        $this->assertNotNull($limited->headers->get('Retry-After'));
    }

    // ---- hand-off and realtime --------------------------------------------------------------------------------------------------

    public function test_the_whatsapp_handoff_matches_the_reference(): void
    {
        [$widget] = $this->whatsAppWidget($this->widget);
        $issued = $this->visitorSession($widget);
        $uri = '/api/v1/public/widgets/'.$widget->public_key.'/whatsapp-handoff';
        $headers = ['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$issued->plaintext];

        $created = $this->withHeaders($headers)->postJson($uri, ['category' => 'billing'])->assertCreated();
        $this->contract($created, 'POST', '/api/v1/public/widgets/{key}/whatsapp-handoff');

        $again = $this->withHeaders($headers)->postJson($uri, ['category' => 'billing'])->assertOk();
        $this->contract($again, 'POST', '/api/v1/public/widgets/{key}/whatsapp-handoff');
        $this->assertSame($created->json('data.code'), $again->json('data.code'));
    }

    public function test_the_channel_authorisation_matches_the_reference(): void
    {
        $this->useReverbBroadcaster();
        $issued = $this->visitorSession($this->widget);
        $conversation = $this->queuedChat($issued, $this->category);

        $signed = $this->visitor($issued->plaintext)->postJson('/api/v1/public/broadcasting/auth', ['socket_id' => '4711.815', 'channel_name' => 'private-conversation.'.$conversation->ulid])->assertOk();
        $this->contract($signed, 'POST', '/api/v1/public/broadcasting/auth');

        $foreign = Conversation::factory()->create();
        $this->contract($this->visitor($issued->plaintext)->postJson('/api/v1/public/broadcasting/auth', ['socket_id' => '4711.815', 'channel_name' => 'private-conversation.'.$foreign->ulid]), 'POST', '/api/v1/public/broadcasting/auth')
            ->assertForbidden()->assertJsonPath('error.code', 'channel_forbidden');

        $this->contract($this->visitor($issued->plaintext)->postJson('/api/v1/public/broadcasting/auth', ['socket_id' => 'nope']), 'POST', '/api/v1/public/broadcasting/auth')->assertStatus(422);
    }
}
