<?php

namespace Tests\Feature\Chat\Api;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\TestCase;

/**
 * `POST /public/widgets/{key}/sessions` and `DELETE /public/sessions`: the gate chain of the public widget API, identity
 * verification, visitor upsert, token issuing (plaintext once) and resuming a still-open chat.
 */
class PublicSessionApiTest extends TestCase
{
    use ChatFixtures, RefreshDatabase;

    private Widget $widget;

    protected function setUp(): void
    {
        parent::setUp();

        [$this->widget] = $this->chatWidget();
    }

    /**
     * @param  array<string, mixed>  $payload
     * @param  array<string, string>  $headers
     */
    private function open(array $payload = [], array $headers = [], ?Widget $widget = null): TestResponse
    {
        $widget ??= $this->widget;

        return $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN] + $headers)
            ->postJson('/api/v1/public/widgets/'.$widget->public_key.'/sessions', $payload);
    }

    public function test_an_anonymous_visitor_gets_a_token_shown_once(): void
    {
        $response = $this->open(['page' => ['url' => 'https://customer.test/pricing', 'title' => 'Pricing', 'referrer' => ''], 'locale' => 'en'])
            ->assertCreated()
            ->assertHeader('Cache-Control', 'no-store, private')
            ->assertJsonPath('data.conversation', null)
            ->assertJsonPath('data.ws', null)
            ->assertJsonStructure(['data' => ['visitorToken', 'expiresAt', 'conversation', 'ws']]);

        $token = $response->json('data.visitorToken');
        $this->assertMatchesRegularExpression('/^vt_[A-Za-z0-9]{40}$/', $token);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', $response->json('data.expiresAt'));

        $session = VisitorSession::query()->sole();
        $this->assertSame(VisitorTokenService::hash($token), $session->token_hash);
        $this->assertSame('https://customer.test/pricing', $session->page_url);
        $this->assertSame('en', $session->locale);
        $this->assertSame($this->widget->id, $session->widget_id);
        $this->assertFalse($session->visitor->verified);
        $this->assertNull($session->visitor->external_id);

        // The plaintext is nowhere in the database.
        $this->assertStringNotContainsString($token, json_encode(VisitorSession::query()->get()->toArray(), JSON_THROW_ON_ERROR));
        $this->assertStringNotContainsString('"id"', (string) $response->getContent());
    }

    public function test_the_websocket_endpoint_is_given_only_when_reverb_is_configured(): void
    {
        // Not configured (the default in tests): no `ws`, the panel stays on REST.
        $this->open()->assertCreated()->assertJsonPath('data.ws', null);

        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.key' => 'public-app-key',
            'broadcasting.connections.reverb.secret' => 'very-secret-value',
            'reverb.apps.apps.0.options.host' => 'chat.example.com',
            'reverb.apps.apps.0.options.port' => 443,
            'reverb.apps.apps.0.options.scheme' => 'https',
        ]);

        $response = $this->open()->assertCreated()->assertJsonPath('data.ws', ['key' => 'public-app-key', 'host' => 'chat.example.com', 'port' => 443, 'scheme' => 'https']);
        $this->assertStringNotContainsString('very-secret-value', (string) $response->getContent());
    }

    public function test_unsigned_visitor_details_are_stored_as_unverified(): void
    {
        $this->open(['visitor' => ['name' => ' Ann ', 'email' => 'ann@example.test', 'phone' => '+1 555 0100', 'meta' => ['plan' => 'pro', 'seats' => 3]]])->assertCreated();

        $visitor = Visitor::query()->sole();
        $this->assertFalse($visitor->verified);
        $this->assertSame('Ann', $visitor->name);
        $this->assertSame('ann@example.test', $visitor->email);
        $this->assertSame('+1 555 0100', $visitor->phone);
        $this->assertSame(['plan' => 'pro', 'seats' => 3], $visitor->meta);
    }

    public function test_a_signed_identity_makes_the_visitor_verified_and_keyed_by_the_subject(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->withIdentitySecret('s3cret-s3cret')->create(['offline_mode' => 'always_online']);
        $claims = fn (string $name): array => ['iss' => $widget->public_key, 'sub' => 'user-42', 'name' => $name, 'email' => 'ann@example.test', 'meta' => ['tier' => 'gold'], 'exp' => time() + 120];

        $this->open(['identity_token' => $this->mintIdentityToken($claims('Ann'), 's3cret-s3cret')], widget: $widget)->assertCreated();
        $this->open(['identity_token' => $this->mintIdentityToken($claims('Ann B.'), 's3cret-s3cret'), 'visitor' => ['name' => 'Ignored']], widget: $widget)->assertCreated();

        $visitor = Visitor::query()->where('widget_id', $widget->id)->sole();
        $this->assertTrue($visitor->verified);
        $this->assertSame('user-42', $visitor->external_id);
        $this->assertSame('Ann B.', $visitor->name);
        $this->assertSame(['tier' => 'gold'], $visitor->meta);
        $this->assertSame(2, VisitorSession::query()->where('visitor_id', $visitor->id)->count());
    }

    public function test_an_identity_that_does_not_verify_is_refused_not_downgraded(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->withIdentitySecret('s3cret-s3cret')->create(['offline_mode' => 'always_online']);
        $forged = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => 'user-42', 'exp' => time() + 120], 'another-secret');
        $expired = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => 'user-42', 'exp' => time() - 10], 's3cret-s3cret');

        foreach ([$forged, $expired, 'not-a-jwt'] as $token) {
            $this->open(['identity_token' => $token], widget: $widget)
                ->assertStatus(422)
                ->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => ['identity_token']]]);
        }

        // A widget without an identity secret cannot verify anything either.
        $this->open(['identity_token' => $forged])->assertStatus(422);
        $this->assertSame(0, VisitorSession::query()->count());
    }

    public function test_a_returning_token_is_rotated_and_resumes_only_an_open_chat(): void
    {
        [$widget, $category] = [$this->widget, $this->widget->categories()->first()];
        $first = $this->visitorSession($widget);
        $chat = $this->queuedChat($first, $category);

        $response = $this->open(headers: $this->bearer($first))->assertCreated();

        $second = $response->json('data.visitorToken');
        $this->assertNotSame($first->plaintext, $second);
        $response->assertJsonPath('data.conversation.ulid', $chat->ulid)->assertJsonPath('data.conversation.status', 'queued');

        // Same visitor, the chat moved to the new session, the old token is dead.
        $this->assertSame(1, Visitor::query()->count());
        $this->assertSame(VisitorTokenService::hash($second), VisitorSession::query()->find($chat->fresh()->visitor_session_id)->token_hash);
        $this->withToken($first->plaintext)->getJson('/api/v1/public/conversation')->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
        $this->withToken($second)->getJson('/api/v1/public/conversation')->assertOk()->assertJsonPath('data.ulid', $chat->ulid);

        // Once the chat is over a returning token starts clean: a new visit is a new ticket.
        $chat->forceFill(['status' => ConversationStatus::Closed, 'close_reason' => ConversationCloseReason::Skipped])->save();
        $this->open(headers: ['Authorization' => 'Bearer '.$second])->assertCreated()->assertJsonPath('data.conversation', null);
    }

    public function test_a_returning_verified_identity_continues_the_chat_from_another_browser(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->withIdentitySecret('s3cret-s3cret')->create(['offline_mode' => 'always_online']);
        $category = Category::factory()->create();
        $visitor = Visitor::factory()->verified('user-7')->create(['widget_id' => $widget->id]);
        $old = app(VisitorTokenService::class)->issue($visitor);
        $chat = $this->activeChat($old, $category, User::factory()->create());

        $token = $this->mintIdentityToken(['iss' => $widget->public_key, 'sub' => 'user-7', 'exp' => time() + 120], 's3cret-s3cret');
        $this->open(['identity_token' => $token], widget: $widget)->assertCreated()->assertJsonPath('data.conversation.ulid', $chat->ulid);

        $this->assertTrue($old->session->fresh()->isRevoked());
        $this->assertNotSame($old->session->id, $chat->fresh()->visitor_session_id);
    }

    public function test_a_previous_verified_visitor_is_not_continued_without_proof(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->create(['offline_mode' => 'always_online']);
        $visitor = Visitor::factory()->verified('user-7')->create(['widget_id' => $widget->id]);
        $old = app(VisitorTokenService::class)->issue($visitor);

        $this->open(headers: $this->bearer($old), widget: $widget)->assertCreated();

        $this->assertSame(2, Visitor::query()->count());
    }

    public function test_a_token_of_another_widget_is_not_a_returning_token(): void
    {
        [$other] = [Widget::factory()->enabled()->create()];
        $foreign = $this->visitorSession($other);

        $this->open(headers: $this->bearer($foreign))->assertCreated();

        $this->assertSame(2, Visitor::query()->count());
        $this->assertFalse($foreign->session->fresh()->isRevoked());
    }

    public function test_unknown_disabled_and_foreign_origin_requests_are_refused(): void
    {
        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->postJson('/api/v1/public/widgets/wk_doesnotexist0000000/sessions')
            ->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');

        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->open()->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
        $this->widget->forceFill(['is_enabled' => true])->save();

        $this->withHeaders(['Origin' => 'https://evil.test'])->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions')
            ->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed');
        $this->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions')
            ->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed');

        $this->assertSame(0, VisitorSession::query()->count());
    }

    public function test_a_non_browser_client_needs_the_widget_to_allow_it(): void
    {
        $this->widget->forceFill(['allow_non_browser_clients' => true])->save();

        $this->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/sessions')->assertCreated();
    }

    public function test_the_payload_is_validated(): void
    {
        $this->open(['visitor' => ['email' => 'not-an-email', 'phone' => 'abc', 'name' => str_repeat('x', 121), 'meta' => ['bad key!' => 'x']], 'locale' => 'not a locale', 'page' => ['url' => str_repeat('u', 2049)]])
            ->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['visitor.email', 'visitor.phone', 'visitor.name', 'visitor.meta', 'locale', 'page.url']]]);

        $this->open(['visitor' => ['meta' => array_fill_keys(array_map(fn (int $i): string => 'k'.$i, range(1, 21)), 'v')]])->assertStatus(422);
    }

    public function test_session_creation_is_rate_limited_per_widget_and_network(): void
    {
        config(['chat.rate_limits.public_session_widget' => 2]);

        $this->open()->assertCreated();
        $this->open()->assertCreated();
        $this->open()->assertStatus(429)->assertJsonPath('error.code', 'rate_limited')->assertHeader('Retry-After');
    }

    public function test_deleting_the_session_revokes_the_token_and_cancels_a_queued_chat(): void
    {
        $category = $this->widget->categories()->first();
        $token = $this->visitorSession($this->widget);
        $chat = $this->queuedChat($token, $category);

        $this->withToken($token->plaintext)->deleteJson('/api/v1/public/sessions')->assertNoContent();

        $this->assertTrue($token->session->fresh()->isRevoked());
        $chat->refresh();
        $this->assertSame(ConversationStatus::Closed, $chat->status);
        $this->assertSame(ConversationCloseReason::Cancelled, $chat->close_reason);
        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_an_active_chat_survives_its_session_being_deleted(): void
    {
        $category = $this->widget->categories()->first();
        $token = $this->visitorSession($this->widget);
        $chat = $this->activeChat($token, $category, User::factory()->create());

        $this->withToken($token->plaintext)->deleteJson('/api/v1/public/sessions')->assertNoContent();

        $this->assertSame(ConversationStatus::Active, $chat->fresh()->status);
    }

    public function test_expired_and_revoked_tokens_are_refused_and_the_panel_is_told_to_start_over(): void
    {
        $category = $this->widget->categories()->first();
        $expired = $this->visitorSession($this->widget);
        $revoked = $this->visitorSession($this->widget);
        $chat = $this->queuedChat($revoked, $category);
        $expired->session->forceFill(['expires_at' => now()->subSecond()])->save();
        $revoked->session->forceFill(['revoked_at' => now()])->save();

        foreach ([$expired, $revoked] as $token) {
            $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
            $this->withToken($token->plaintext)->postJson('/api/v1/public/conversations', ['category' => 'billing'])->assertStatus(401)->assertJsonPath('error.code', 'session_revoked');
            $this->withToken($token->plaintext)->postJson("/api/v1/public/conversations/{$chat->ulid}/messages", ['body' => 'x'])->assertStatus(401);
        }

        // A malformed or unknown token is simply unauthenticated; the token is never accepted in the query string or a cookie.
        $this->withToken('vt_'.str_repeat('a', 40))->getJson('/api/v1/public/conversation')->assertStatus(401)->assertJsonPath('error.code', 'unauthenticated');
        $this->getJson('/api/v1/public/conversation?token='.$this->visitorSession($this->widget)->plaintext)->assertStatus(401);
        $this->withCookie('visitor_token', $this->visitorSession($this->widget)->plaintext)->getJson('/api/v1/public/conversation')->assertStatus(401);
    }

    public function test_every_visitor_call_needs_a_valid_token_and_an_enabled_widget(): void
    {
        $token = $this->visitorSession($this->widget);
        $ulid = '01JABCDEFGHJKMNPQRSTVWXYZ0';
        $calls = [
            ['getJson', '/api/v1/public/conversation'],
            ['postJson', '/api/v1/public/conversations'],
            ['postJson', '/api/v1/public/offline-tickets'],
            ['getJson', "/api/v1/public/conversations/{$ulid}/messages"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/messages"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/attachments"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/receipts"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/typing"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/end"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/cancel"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/rating"],
            ['postJson', "/api/v1/public/conversations/{$ulid}/rating/skip"],
            ['deleteJson', '/api/v1/public/sessions'],
        ];

        foreach ($calls as [$method, $url]) {
            $this->{$method}($url)->assertStatus(401)->assertJsonPath('error.code', 'unauthenticated');
        }

        $this->widget->forceFill(['is_enabled' => false])->save();

        foreach ($calls as [$method, $url]) {
            $this->withToken($token->plaintext)->{$method}($url)->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
        }

        $this->widget->forceFill(['is_enabled' => true])->delete();

        $this->withToken($token->plaintext)->getJson('/api/v1/public/conversation')->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
    }
}
