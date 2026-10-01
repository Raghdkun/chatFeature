<?php

namespace Tests\Feature\Realtime;

use App\Domain\Visitors\IssuedVisitorToken;
use App\Domain\Visitors\VisitorTokenService;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Visitor;
use App\Models\VisitorSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * `POST /api/v1/public/broadcasting/auth`: a visitor may sign for exactly one channel, `private-conversation.{ulid}` of the
 * conversation their session is bound to. Everything else is `403`.
 */
class VisitorBroadcastingAuthTest extends TestCase
{
    use InteractsWithRealtime, RefreshDatabase;

    private const URL = '/api/v1/public/broadcasting/auth';

    private const SOCKET = '4711.815';

    private IssuedVisitorToken $issued;

    private Conversation $conversation;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useReverbBroadcaster();

        $this->issued = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        $this->conversation = $this->conversationOf($this->issued->session);
    }

    private function conversationOf(VisitorSession $session): Conversation
    {
        return Conversation::factory()->create(['visitor_id' => $session->visitor_id, 'widget_id' => $session->widget_id, 'visitor_session_id' => $session->id]);
    }

    private function channelOf(Conversation $conversation): string
    {
        return 'private-conversation.'.$conversation->ulid;
    }

    /**
     * @param  array<string, mixed>  $body
     */
    private function sign(?string $token, array $body): TestResponse
    {
        $client = $token === null ? $this : $this->withToken($token);

        return $client->postJson(self::URL, $body);
    }

    public function test_a_visitor_signs_for_the_conversation_their_session_is_bound_to(): void
    {
        $channel = $this->channelOf($this->conversation);

        $response = $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $channel])->assertOk();

        $this->assertSame(['auth' => $this->expectedChannelAuth(self::SOCKET, $channel)], $response->json());
    }

    public function test_it_accepts_what_pusher_js_posts_a_form_body(): void
    {
        $channel = $this->channelOf($this->conversation);

        $response = $this->withToken($this->issued->plaintext)->post(self::URL, ['socket_id' => self::SOCKET, 'channel_name' => $channel])->assertOk();

        $this->assertSame($this->expectedChannelAuth(self::SOCKET, $channel), $response->json('auth'));
    }

    public function test_the_answer_is_not_cacheable_and_sets_no_cookie(): void
    {
        $response = $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)])->assertOk();

        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertSame([], $response->headers->getCookies());
        $this->assertNull($response->headers->get('Set-Cookie'));
    }

    public function test_the_signature_depends_on_the_socket_so_it_cannot_be_replayed_for_another_connection(): void
    {
        $channel = $this->channelOf($this->conversation);

        $a = $this->sign($this->issued->plaintext, ['socket_id' => '1.1', 'channel_name' => $channel])->json('auth');
        $b = $this->sign($this->issued->plaintext, ['socket_id' => '2.2', 'channel_name' => $channel])->json('auth');

        $this->assertNotSame($a, $b);
    }

    // ---- ownership ---------------------------------------------------------------------------------------------------------

    public function test_another_visitors_conversation_is_forbidden_not_unknown(): void
    {
        $stranger = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        $theirs = $this->conversationOf($stranger->session);

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($theirs)])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'channel_forbidden');
    }

    public function test_another_session_of_the_same_visitor_does_not_own_the_conversation(): void
    {
        $second = app(VisitorTokenService::class)->issue($this->issued->session->visitor);

        $this->sign($second->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)])->assertForbidden();
    }

    public function test_a_conversation_without_a_session_belongs_to_nobody_here(): void
    {
        $orphan = Conversation::factory()->create(['visitor_id' => $this->issued->session->visitor_id, 'widget_id' => $this->issued->session->widget_id, 'visitor_session_id' => null]);

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($orphan)])->assertForbidden();
    }

    public function test_an_unknown_conversation_is_forbidden_not_404(): void
    {
        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => 'private-conversation.01JZZZZZZZZZZZZZZZZZZZZZZZ'])
            ->assertForbidden()
            ->assertJsonPath('error.code', 'channel_forbidden');
    }

    public function test_a_finished_conversation_of_the_session_can_still_be_joined(): void
    {
        $closed = Conversation::factory()->closed()->create(['visitor_id' => $this->issued->session->visitor_id, 'widget_id' => $this->issued->session->widget_id, 'visitor_session_id' => $this->issued->session->id]);

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($closed)])->assertOk();
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function channelsAVisitorNeverGets(): iterable
    {
        yield 'staff channel' => ['private-staff.1'];
        yield 'admin channel' => ['private-admin'];
        yield 'roster' => ['presence-staff'];
        yield 'whatsapp admin' => ['private-whatsapp-admin'];
        yield 'presence kind of the own conversation' => ['presence-conversation.{ulid}'];
        yield 'public name of the own conversation' => ['conversation.{ulid}'];
        yield 'upper case ulid' => ['private-conversation.{ULID}'];
        yield 'extra segment' => ['private-conversation.{ulid}.more'];
        yield 'prefixed' => ['x-private-conversation.{ulid}'];
        yield 'wildcard' => ['private-conversation.*'];
        yield 'not a ulid' => ['private-conversation.123'];
        yield 'no id' => ['private-conversation.'];
        yield 'kit user channel' => ['private-App.Models.User.1'];
        yield 'garbage' => ['!!!'];
    }

    #[DataProvider('channelsAVisitorNeverGets')]
    public function test_every_other_channel_is_forbidden(string $template): void
    {
        $channel = str_replace(['{ulid}', '{ULID}'], [$this->conversation->ulid, strtoupper($this->conversation->ulid)], $template);

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $channel])->assertForbidden();
    }

    // ---- input -------------------------------------------------------------------------------------------------------------

    /**
     * @return iterable<string, array{array<string, mixed>}>
     */
    public static function malformedBodies(): iterable
    {
        yield 'nothing' => [[]];
        yield 'no socket' => [['channel_name' => 'private-conversation.x']];
        yield 'no channel' => [['socket_id' => self::SOCKET]];
        yield 'socket without a dot' => [['socket_id' => '4711', 'channel_name' => 'private-conversation.x']];
        yield 'socket with three parts' => [['socket_id' => '1.2.3', 'channel_name' => 'private-conversation.x']];
        yield 'socket with letters' => [['socket_id' => 'a.b', 'channel_name' => 'private-conversation.x']];
        yield 'socket with inner whitespace' => [['socket_id' => '1. 2', 'channel_name' => 'private-conversation.x']];
        yield 'socket too long' => [['socket_id' => str_repeat('1', 13).'.1', 'channel_name' => 'private-conversation.x']];
        yield 'socket as array' => [['socket_id' => ['1.2'], 'channel_name' => 'private-conversation.x']];
        yield 'channel as array' => [['socket_id' => self::SOCKET, 'channel_name' => ['private-conversation.x']]];
        yield 'channel too long' => [['socket_id' => self::SOCKET, 'channel_name' => str_repeat('a', 101)]];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('malformedBodies')]
    public function test_a_malformed_body_is_a_validation_error(array $body): void
    {
        $this->sign($this->issued->plaintext, $body)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed');
    }

    // ---- who is calling ----------------------------------------------------------------------------------------------------

    public function test_the_visitor_token_is_required(): void
    {
        $body = ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)];

        $this->sign(null, $body)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->sign('not-a-token', $body)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->sign('vt_'.str_repeat('a', 40), $body)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_a_revoked_or_expired_session_is_told_to_start_over(): void
    {
        $body = ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)];

        app(VisitorTokenService::class)->revoke($this->issued->session);
        $this->sign($this->issued->plaintext, $body)->assertUnauthorized()->assertJsonPath('error.code', 'session_revoked');

        $expired = app(VisitorTokenService::class)->issue(Visitor::factory()->create(), expiresAt: now()->subMinute());
        $this->sign($expired->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversationOf($expired->session))])
            ->assertUnauthorized()->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_a_staff_credential_is_not_accepted_here(): void
    {
        $token = User::factory()->admin()->create()->createToken('phone', ['staff'])->plainTextToken;

        $this->sign($token, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)])->assertUnauthorized();
    }

    public function test_the_token_is_not_taken_from_the_query_string_or_a_cookie(): void
    {
        $url = self::URL.'?token='.$this->issued->plaintext.'&access_token='.$this->issued->plaintext;
        $body = ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)];

        $this->postJson($url, $body)->assertUnauthorized();
        $this->withCookie('vt', $this->issued->plaintext)->postJson(self::URL, $body)->assertUnauthorized();
    }

    // ---- realtime off ------------------------------------------------------------------------------------------------------

    public function test_without_a_realtime_broadcaster_the_answer_is_a_clear_503(): void
    {
        config(['broadcasting.default' => 'null']);
        app('Illuminate\Broadcasting\BroadcastManager')->purge('null');

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)])
            ->assertStatus(503)
            ->assertJsonPath('error.code', 'realtime_unavailable');
    }

    public function test_a_refusal_comes_before_the_503(): void
    {
        config(['broadcasting.default' => 'null']);
        app('Illuminate\Broadcasting\BroadcastManager')->purge('null');

        $this->sign($this->issued->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => 'private-admin'])->assertForbidden();
    }

    // ---- rate limit --------------------------------------------------------------------------------------------------------

    public function test_a_token_may_ask_only_so_often(): void
    {
        RateLimiter::clear('bcast-token:'.hash('sha256', $this->issued->plaintext));
        config(['broadcasting.realtime.auth_rate_limits.per_token' => 3]);
        $body = ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversation)];

        for ($i = 0; $i < 3; $i++) {
            $this->sign($this->issued->plaintext, $body)->assertOk();
        }

        $this->sign($this->issued->plaintext, $body)->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        // Another visitor behind the same address is not locked out by it.
        $other = app(VisitorTokenService::class)->issue(Visitor::factory()->create());
        $this->sign($other->plaintext, ['socket_id' => self::SOCKET, 'channel_name' => $this->channelOf($this->conversationOf($other->session))])->assertOk();
    }

    public function test_one_network_may_ask_only_so_often_whatever_the_tokens(): void
    {
        config(['broadcasting.realtime.auth_rate_limits.per_network' => 2]);

        $this->sign('vt_'.str_repeat('a', 40), ['socket_id' => self::SOCKET, 'channel_name' => 'private-conversation.x'])->assertUnauthorized();
        $this->sign('vt_'.str_repeat('b', 40), ['socket_id' => self::SOCKET, 'channel_name' => 'private-conversation.x'])->assertUnauthorized();
        $this->sign('vt_'.str_repeat('c', 40), ['socket_id' => self::SOCKET, 'channel_name' => 'private-conversation.x'])->assertStatus(429);
    }

    public function test_the_limiter_is_the_named_one_of_the_contract(): void
    {
        $route = app('router')->getRoutes()->getByName('api.public.broadcasting.auth');

        $this->assertNotNull($route);
        $this->assertContains('throttle:broadcasting-auth', $route->gatherMiddleware());
        $this->assertContains('visitor', $route->gatherMiddleware());
        $this->assertNotContains('web', $route->gatherMiddleware());
        $this->assertNotNull(RateLimiter::limiter('broadcasting-auth'));
    }
}
