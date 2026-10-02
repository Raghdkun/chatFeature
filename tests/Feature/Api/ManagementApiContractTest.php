<?php

namespace Tests\Feature\Api;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use App\Support\ApiDocs\ApiAudience;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\AssertsOpenApi;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithWebPush;
use Tests\TestCase;

/**
 * The staff API against its committed OpenAPI file ({@see AssertsOpenApi}), called the way a mobile app calls it: with a bearer token.
 * Every answer of the main flows (credential, presence, notifications, the inbox and everything an agent does to a chat, categories,
 * agents, widgets) is checked against the schema the reference gives that operation, errors included.
 */
class ManagementApiContractTest extends TestCase
{
    use AssertsOpenApi, ChatFixtures, InteractsWithWebPush, RefreshDatabase;

    private User $admin;

    private User $agent;

    private Category $category;

    private Widget $widget;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        [$this->widget, $this->category] = $this->chatWidget();
        $this->admin = User::factory()->admin()->create(['is_agent' => false]);
        $this->agent = $this->availableAgent($this->category);
    }

    /** A call by `$user` with a fresh bearer token (the test client keeps headers and the resolved user between calls). */
    private function as(User $user): static
    {
        $this->app['auth']->forgetGuards();

        return $this->flushHeaders()->withToken($user->createToken('contract', ['staff'])->plainTextToken);
    }

    private function contract(TestResponse $response, string $method, string $path): TestResponse
    {
        $this->assertMatchesOpenApi($response, ApiAudience::Management, $method, $path);

        return $response;
    }

    // ---- credential, presence, notifications ---------------------------------------------------------------------------------------

    public function test_the_credential_endpoints_match_the_reference(): void
    {
        $this->contract($this->as($this->agent)->getJson('/api/v1/auth/me'), 'GET', '/api/v1/auth/me')->assertOk();
        $this->contract($this->as($this->agent)->getJson('/api/v1/auth/tokens'), 'GET', '/api/v1/auth/tokens')->assertOk();

        $tokenId = (int) $this->agent->tokens()->orderByDesc('id')->value('id');
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/auth/tokens/'.$tokenId), 'DELETE', '/api/v1/auth/tokens/{token}')->assertNoContent();
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/auth/tokens/999999'), 'DELETE', '/api/v1/auth/tokens/{token}')->assertNotFound()->assertJsonPath('error.code', 'token_not_found');
        $this->contract($this->as($this->agent)->postJson('/api/v1/auth/logout'), 'POST', '/api/v1/auth/logout')->assertNoContent();

        $this->app['auth']->forgetGuards();
        $this->contract($this->flushHeaders()->actingAs($this->agent)->postJson('/api/v1/auth/logout'), 'POST', '/api/v1/auth/logout')->assertStatus(409);

        $this->app['auth']->forgetGuards();
        $this->flushSession();
        $this->contract($this->flushHeaders()->getJson('/api/v1/auth/me'), 'GET', '/api/v1/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_presence_and_notification_settings_match_the_reference(): void
    {
        $this->contract($this->as($this->agent)->putJson('/api/v1/me/presence', ['status' => 'online', 'automatic' => true]), 'PUT', '/api/v1/me/presence')->assertOk();
        $this->contract($this->as($this->agent)->getJson('/api/v1/me/presence'), 'GET', '/api/v1/me/presence')->assertOk();
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/presence/heartbeat', ['visible' => false]), 'POST', '/api/v1/me/presence/heartbeat')->assertOk();
        $this->contract($this->as($this->agent)->putJson('/api/v1/me/presence', ['status' => 'sleeping']), 'PUT', '/api/v1/me/presence')->assertStatus(422);

        $this->contract($this->as($this->agent)->getJson('/api/v1/me/notification-settings'), 'GET', '/api/v1/me/notification-settings')->assertOk();
        $this->contract($this->as($this->agent)->putJson('/api/v1/me/notification-settings', ['sound' => false, 'quiet_hours' => ['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'Europe/Berlin'], 'prompt_state' => 'snoozed']), 'PUT', '/api/v1/me/notification-settings')->assertOk();
        $this->contract($this->as($this->agent)->putJson('/api/v1/me/notification-settings', ['quiet_hours' => ['enabled' => true, 'start' => '08:00', 'end' => '08:00']]), 'PUT', '/api/v1/me/notification-settings')->assertStatus(422);
    }

    public function test_push_subscriptions_and_mobile_devices_match_the_reference(): void
    {
        $this->useVapid();
        $this->fakePushService();
        $subscription = ['endpoint' => 'https://'.self::PUSH_HOST.'/fcm/send/'.Str::random(100), 'expirationTime' => null, 'keys' => $this->pushKeys()];

        $this->contract($this->as($this->agent)->getJson('/api/v1/me/push-subscriptions'), 'GET', '/api/v1/me/push-subscriptions')->assertOk();
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/push-subscriptions/test'), 'POST', '/api/v1/me/push-subscriptions/test')->assertStatus(409)->assertJsonPath('error.code', 'no_push_devices');

        $created = $this->contract($this->as($this->agent)->postJson('/api/v1/me/push-subscriptions', $subscription), 'POST', '/api/v1/me/push-subscriptions')->assertCreated();
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/push-subscriptions', $subscription), 'POST', '/api/v1/me/push-subscriptions')->assertOk();
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/push-subscriptions', ['endpoint' => 'http://insecure.test/x']), 'POST', '/api/v1/me/push-subscriptions')->assertStatus(422);
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/push-subscriptions/test'), 'POST', '/api/v1/me/push-subscriptions/test')->assertOk();
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/me/push-subscriptions/'.$created->json('data.id')), 'DELETE', '/api/v1/me/push-subscriptions/{subscription}')->assertNoContent();
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/me/push-subscriptions/'.$created->json('data.id')), 'DELETE', '/api/v1/me/push-subscriptions/{subscription}')->assertNotFound();

        $device = ['platform' => 'android', 'token' => Str::random(60)];
        $registered = $this->contract($this->as($this->agent)->postJson('/api/v1/me/devices', $device), 'POST', '/api/v1/me/devices')->assertCreated();
        $this->contract($this->as($this->agent)->postJson('/api/v1/me/devices', $device), 'POST', '/api/v1/me/devices')->assertOk();
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/me/devices/'.$registered->json('data.id')), 'DELETE', '/api/v1/me/devices/{device}')->assertNoContent();
        $this->contract($this->as($this->agent)->deleteJson('/api/v1/me/devices/'.$registered->json('data.id')), 'DELETE', '/api/v1/me/devices/{device}')->assertNotFound()->assertJsonPath('error.code', 'device_not_found');
    }

    // ---- the inbox -----------------------------------------------------------------------------------------------------------------

    public function test_what_an_agent_does_to_a_chat_matches_the_reference(): void
    {
        $issued = $this->visitorSession($this->widget);
        $chat = $this->queuedChat($issued, $this->category, [$this->agent]);
        $uri = '/api/v1/conversations/'.$chat->ulid;

        $this->contract($this->as($this->agent)->getJson('/api/v1/conversations/queue'), 'GET', '/api/v1/conversations/queue')->assertOk()->assertJsonCount(1, 'data');
        $this->contract($this->as($this->agent)->getJson('/api/v1/conversations?status=queued,active&limit=10'), 'GET', '/api/v1/conversations')->assertOk();
        $this->contract($this->as($this->agent)->getJson('/api/v1/conversations?status=nonsense'), 'GET', '/api/v1/conversations')->assertStatus(422);
        $this->contract($this->as($this->agent)->getJson($uri), 'GET', '/api/v1/conversations/{conversation}')->assertOk();

        $this->contract($this->as($this->agent)->postJson($uri.'/claim'), 'POST', '/api/v1/conversations/{conversation}/claim')->assertOk()->assertJsonPath('data.status', 'active');

        $first = $this->contract($this->as($this->agent)->postJson($uri.'/messages', ['client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w2', 'body' => 'Hello, how can I help?']), 'POST', '/api/v1/conversations/{conversation}/messages')->assertCreated();
        $replay = $this->contract($this->as($this->agent)->postJson($uri.'/messages', ['client_msg_id' => '01j9z3q8x7m5n2k4p6r8t0v1w2', 'body' => 'Hello, how can I help?']), 'POST', '/api/v1/conversations/{conversation}/messages')->assertOk();
        $this->assertSame($first->json('data.ulid'), $replay->json('data.ulid'));

        $upload = $this->contract($this->as($this->agent)->post($uri.'/attachments', ['file' => $this->pngUpload()], ['Accept' => 'application/json']), 'POST', '/api/v1/conversations/{conversation}/attachments')->assertCreated();
        $this->contract($this->as($this->agent)->postJson($uri.'/messages', ['attachments' => [$upload->json('data.ulid')]]), 'POST', '/api/v1/conversations/{conversation}/messages')->assertCreated();

        $messages = $this->contract($this->as($this->agent)->getJson($uri.'/messages?after_seq=0'), 'GET', '/api/v1/conversations/{conversation}/messages')->assertOk();
        $this->assertNotEmpty($messages->json('data'));
        $seq = (int) collect($messages->json('data'))->max('seq');

        $this->contract($this->as($this->agent)->postJson($uri.'/receipts', ['seen_upto' => $seq]), 'POST', '/api/v1/conversations/{conversation}/receipts')->assertNoContent();
        $this->contract($this->as($this->agent)->postJson($uri.'/typing', ['typing' => true]), 'POST', '/api/v1/conversations/{conversation}/typing')->assertNoContent();
        $this->contract($this->as($this->agent)->postJson($uri.'/receipts', []), 'POST', '/api/v1/conversations/{conversation}/receipts')->assertStatus(422);

        $colleague = $this->availableAgent($this->category);
        $targets = $this->contract($this->as($this->agent)->getJson($uri.'/transfer-targets'), 'GET', '/api/v1/conversations/{conversation}/transfer-targets')->assertOk();
        $this->assertSame([$colleague->id], array_column($targets->json('data.agents'), 'id'));

        $this->contract($this->as($this->agent)->postJson($uri.'/transfer', ['agent_id' => $colleague->id]), 'POST', '/api/v1/conversations/{conversation}/transfer')->assertOk()->assertJsonPath('data.status', 'queued');
        $this->contract($this->as($this->agent)->postJson($uri.'/transfer', []), 'POST', '/api/v1/conversations/{conversation}/transfer')->assertStatus(422);

        $this->contract($this->as($colleague)->postJson($uri.'/claim'), 'POST', '/api/v1/conversations/{conversation}/claim')->assertOk();
        $this->contract($this->as($this->agent)->postJson($uri.'/claim'), 'POST', '/api/v1/conversations/{conversation}/claim')->assertStatus(409)->assertJsonPath('error.code', 'already_claimed')->assertJsonPath('error.details.by', $colleague->label);

        $this->contract($this->as($this->agent)->postJson($uri.'/end'), 'POST', '/api/v1/conversations/{conversation}/end')->assertForbidden();
        $this->contract($this->as($colleague)->postJson($uri.'/end'), 'POST', '/api/v1/conversations/{conversation}/end')->assertOk()->assertJsonPath('data.ratingRequested', true);
        $this->contract($this->as($colleague)->postJson($uri.'/end'), 'POST', '/api/v1/conversations/{conversation}/end')->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_active');
    }

    public function test_closing_exporting_and_the_access_errors_match_the_reference(): void
    {
        $issued = $this->visitorSession($this->widget);
        $chat = $this->activeChat($issued, $this->category, $this->agent);
        $other = $this->visitorSession($this->widget);
        $hidden = $this->activeChat($other, $this->category, $this->availableAgent($this->category));

        // Another agent's chat is a 403, and the list never shows it.
        $this->contract($this->as($this->agent)->getJson('/api/v1/conversations/'.$hidden->ulid), 'GET', '/api/v1/conversations/{conversation}')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->contract($this->as($this->agent)->postJson('/api/v1/conversations/'.$hidden->ulid.'/messages', ['body' => 'nope']), 'POST', '/api/v1/conversations/{conversation}/messages')->assertForbidden();
        $this->contract($this->as($this->agent)->getJson('/api/v1/conversations/not-a-ulid'), 'GET', '/api/v1/conversations/{conversation}')->assertNotFound();

        $this->contract($this->as($this->admin)->postJson('/api/v1/conversations/'.$chat->ulid.'/close'), 'POST', '/api/v1/conversations/{conversation}/close')->assertOk()->assertJsonPath('data.status', 'closed');
        $this->contract($this->as($this->admin)->postJson('/api/v1/conversations/'.$chat->ulid.'/close'), 'POST', '/api/v1/conversations/{conversation}/close')->assertStatus(409)->assertJsonPath('error.code', 'conversation_not_open');

        $csv = $this->as($this->admin)->get('/api/v1/conversations/export?format=csv')->assertOk();
        $this->contract($csv, 'GET', '/api/v1/conversations/export');
        $this->assertStringContainsString('attachment', (string) $csv->headers->get('Content-Disposition'));
        $this->assertStringStartsWith('ticket_no,conversation,type,status', $csv->streamedContent());

        $json = $this->as($this->admin)->get('/api/v1/conversations/export?format=json')->assertOk();
        $rows = json_decode($json->streamedContent(), true, 512, JSON_THROW_ON_ERROR)['data'];
        $this->assertCount(Conversation::query()->count(), $rows);
        $this->assertSame(['ticket_no', 'conversation', 'type', 'status', 'widget', 'category', 'agent', 'visitor_name', 'visitor_email', 'visitor_verified', 'created_at', 'claimed_at', 'ended_at', 'closed_at', 'ended_by', 'close_reason', 'messages', 'rating'], array_keys($rows[0]), 'the documented export columns');

        $this->contract($this->as($this->agent)->get('/api/v1/conversations/export', ['Accept' => 'application/json']), 'GET', '/api/v1/conversations/export')->assertForbidden();
    }

    public function test_an_agent_who_is_offline_or_has_no_chat_role_gets_the_documented_errors(): void
    {
        $this->setPresence($this->agent, PresenceStatus::Offline);
        $noRole = User::factory()->withoutChatAccess()->create();

        $this->contract($this->as($noRole)->getJson('/api/v1/conversations'), 'GET', '/api/v1/conversations')->assertForbidden()->assertJsonPath('error.code', 'no_chat_access');
        $this->contract($this->as($this->agent)->getJson('/api/v1/widgets'), 'GET', '/api/v1/widgets')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
    }

    // ---- directory -------------------------------------------------------------------------------------------------------------------

    public function test_categories_and_agents_match_the_reference(): void
    {
        $this->contract($this->as($this->agent)->getJson('/api/v1/categories'), 'GET', '/api/v1/categories')->assertOk();
        $this->contract($this->as($this->agent)->getJson('/api/v1/me/categories'), 'GET', '/api/v1/me/categories')->assertOk();

        $created = $this->contract($this->as($this->admin)->postJson('/api/v1/categories', ['name' => 'Shipping', 'slug' => 'shipping', 'color' => '#0ea5e9', 'name_i18n' => ['de' => 'Versand']]), 'POST', '/api/v1/categories')->assertCreated();
        $ulid = (string) $created->json('data.ulid');
        $this->contract($this->as($this->admin)->postJson('/api/v1/categories', ['name' => 'Again', 'slug' => 'shipping']), 'POST', '/api/v1/categories')->assertStatus(422);
        $this->contract($this->as($this->admin)->getJson('/api/v1/categories/'.$ulid), 'GET', '/api/v1/categories/{category}')->assertOk();
        $this->contract($this->as($this->admin)->patchJson('/api/v1/categories/'.$ulid, ['description' => 'Parcels and returns.', 'sort_order' => 5]), 'PATCH', '/api/v1/categories/{category}')->assertOk();
        $this->contract($this->as($this->agent)->putJson('/api/v1/me/categories', ['category_ulids' => [$this->category->ulid, $ulid]]), 'PUT', '/api/v1/me/categories')->assertOk();
        $this->contract($this->as($this->admin)->putJson('/api/v1/me/categories', ['category_ulids' => []]), 'PUT', '/api/v1/me/categories')->assertForbidden();
        $this->contract($this->as($this->admin)->deleteJson('/api/v1/categories/'.$ulid), 'DELETE', '/api/v1/categories/{category}')->assertNoContent();

        $this->contract($this->as($this->admin)->getJson('/api/v1/agents'), 'GET', '/api/v1/agents')->assertOk();
        $agent = $this->contract($this->as($this->admin)->postJson('/api/v1/agents', ['name' => 'Sam Rivera', 'email' => 'sam@example.com', 'password' => 'correct-Horse-battery-9!', 'category_ulids' => [$this->category->ulid]]), 'POST', '/api/v1/agents')->assertCreated();
        $this->contract($this->as($this->admin)->postJson('/api/v1/agents', ['name' => 'Sam Rivera', 'email' => 'sam@example.com', 'password' => 'correct-Horse-battery-9!']), 'POST', '/api/v1/agents')->assertStatus(422);
        $id = (int) $agent->json('data.id');
        $this->contract($this->as($this->admin)->patchJson('/api/v1/agents/'.$id, ['max_concurrent_chats' => 3]), 'PATCH', '/api/v1/agents/{agent}')->assertOk();
        $this->contract($this->as($this->admin)->patchJson('/api/v1/agents/'.$id.'/categories', ['category_ulids' => []]), 'PATCH', '/api/v1/agents/{agent}/categories')->assertOk();
        $this->contract($this->as($this->admin)->patchJson('/api/v1/agents/'.$this->admin->id, ['is_active' => false]), 'PATCH', '/api/v1/agents/{agent}')->assertStatus(409)->assertJsonPath('error.code', 'cannot_deactivate_self');
        $this->contract($this->as($this->admin)->patchJson('/api/v1/agents/'.$this->admin->id.'/categories', ['category_ulids' => []]), 'PATCH', '/api/v1/agents/{agent}/categories')->assertStatus(409)->assertJsonPath('error.code', 'not_an_agent');
    }

    public function test_widgets_match_the_reference(): void
    {
        $this->contract($this->as($this->admin)->getJson('/api/v1/widgets'), 'GET', '/api/v1/widgets')->assertOk();

        $created = $this->contract($this->as($this->admin)->postJson('/api/v1/widgets', ['name' => 'Main website']), 'POST', '/api/v1/widgets')->assertCreated();
        $ulid = (string) $created->json('data.ulid');
        $uri = '/api/v1/widgets/'.$ulid;

        $this->contract($this->as($this->admin)->getJson($uri), 'GET', '/api/v1/widgets/{widget}')->assertOk();
        $this->contract($this->as($this->admin)->patchJson($uri, ['is_enabled' => true, 'idle_timeout_minutes' => 60]), 'PATCH', '/api/v1/widgets/{widget}')->assertOk();
        $this->contract($this->as($this->admin)->patchJson($uri, ['idle_timeout_minutes' => 1]), 'PATCH', '/api/v1/widgets/{widget}')->assertStatus(422);
        $this->contract($this->as($this->admin)->putJson($uri.'/draft', ['config' => ['bogus' => true]]), 'PUT', '/api/v1/widgets/{widget}/draft')->assertStatus(422);
        $this->contract($this->as($this->admin)->putJson($uri.'/domains', ['domains' => ['example.com', '*.example.org']]), 'PUT', '/api/v1/widgets/{widget}/domains')->assertOk();
        $this->assertEqualsCanonicalizing(['example.com', '*.example.org'], $this->as($this->admin)->putJson($uri.'/domains', ['domains' => ['example.com', '*.example.org']])->json('data.domains'), 'the normalised, de-duplicated list');
        $this->contract($this->as($this->admin)->putJson($uri.'/domains', ['domains' => ['not a host']]), 'PUT', '/api/v1/widgets/{widget}/domains')->assertStatus(422);
        $this->contract($this->as($this->admin)->putJson($uri.'/categories', ['category_ulids' => [$this->category->ulid]]), 'PUT', '/api/v1/widgets/{widget}/categories')->assertOk();
        $this->contract($this->as($this->admin)->putJson($uri.'/greetings', ['greetings' => [['body' => 'Hi! Need a hand?', 'agent_name' => 'Sam']]]), 'PUT', '/api/v1/widgets/{widget}/greetings')->assertOk();
        $this->contract($this->as($this->admin)->postJson($uri.'/publish'), 'POST', '/api/v1/widgets/{widget}/publish')->assertOk();
        $this->contract($this->as($this->admin)->getJson($uri.'/snippet'), 'GET', '/api/v1/widgets/{widget}/snippet')->assertOk();

        $secret = $this->contract($this->as($this->admin)->postJson($uri.'/rotate-secret'), 'POST', '/api/v1/widgets/{widget}/rotate-secret')->assertOk();
        $this->assertStringContainsString('no-store', (string) $secret->headers->get('Cache-Control'));
        $this->assertStringNotContainsString((string) $secret->json('data.identity_secret'), (string) $this->as($this->admin)->getJson($uri)->getContent(), 'the secret is shown once');

        $this->contract($this->as($this->agent)->getJson($uri), 'GET', '/api/v1/widgets/{widget}')->assertForbidden();
        $this->contract($this->as($this->admin)->deleteJson($uri), 'DELETE', '/api/v1/widgets/{widget}')->assertNoContent();
        $this->contract($this->as($this->admin)->getJson($uri), 'GET', '/api/v1/widgets/{widget}')->assertNotFound();
    }
}
