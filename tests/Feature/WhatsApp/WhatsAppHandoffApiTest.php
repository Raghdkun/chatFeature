<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\Visitors\IssuedVisitorToken;
use App\Models\Category;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaHandoffTicket;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\ChatFixtures;
use Tests\Support\InteractsWithWhatsAppWidgets;
use Tests\TestCase;

/**
 * `POST /public/widgets/{key}/whatsapp-handoff`: the visitor's code and `wa.me` link, behind the same gates as starting a chat, with its own
 * limits, and nothing in the answer but `{code, waUrl, expiresAt, ttlSeconds}`.
 */
class WhatsAppHandoffApiTest extends TestCase
{
    use ChatFixtures, InteractsWithWhatsAppWidgets, RefreshDatabase;

    private Widget $widget;

    private Category $billing;

    private WhatsAppSession $session;

    private IssuedVisitorToken $token;

    protected function setUp(): void
    {
        parent::setUp();

        [$widget, $this->billing] = $this->chatWidget();
        [$this->widget, $this->session] = $this->whatsAppWidget($widget);
        $this->token = $this->visitorSession($this->widget);
    }

    /**
     * @param  array<string, mixed>  $payload
     * @param  array<string, string>  $headers
     */
    private function handoff(array $payload = [], ?IssuedVisitorToken $token = null, ?Widget $widget = null, array $headers = []): TestResponse
    {
        $widget ??= $this->widget;
        $token ??= $this->token;

        return $this->withHeaders($headers + ['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$token->plaintext])
            ->postJson('/api/v1/public/widgets/'.$widget->public_key.'/whatsapp-handoff', $payload);
    }

    public function test_a_visitor_gets_a_code_a_link_with_the_code_typed_in_and_an_expiry(): void
    {
        $response = $this->handoff(['category' => 'billing'])->assertCreated();

        $data = $response->json('data');
        $this->assertSame(['code', 'waUrl', 'expiresAt', 'ttlSeconds'], array_keys($data));
        $this->assertEqualsWithDelta(1440 * 60, $data['ttlSeconds'], 5);
        $this->assertMatchesRegularExpression('/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/', $data['code']);
        $this->assertSame('https://wa.me/4915123456789?text='.rawurlencode('Hi! My support code is '.$data['code']), $data['waUrl']);
        $this->assertEqualsWithDelta(now()->addMinutes(1440)->getTimestamp(), strtotime($data['expiresAt']), 5);

        $ticket = WaHandoffTicket::query()->sole();
        $this->assertSame($data['code'], $ticket->code);
        $this->assertSame($this->widget->id, $ticket->widget_id);
        $this->assertSame($this->token->session->visitor_id, $ticket->visitor_id);
        $this->assertSame($this->billing->id, $ticket->category_id);
        $this->assertSame($this->session->id, $ticket->session_id);
        $this->assertNull($ticket->consumed_at);
    }

    public function test_the_answer_says_nothing_else_about_the_session_the_widget_or_the_ticket(): void
    {
        $body = $this->handoff()->assertCreated()->getContent();

        $this->assertStringNotContainsString($this->session->ulid, $body);
        $this->assertStringNotContainsString($this->session->name, $body);
        $this->assertStringNotContainsString((string) $this->session->openwa_session_id, $body);
        $this->assertStringNotContainsString(WaHandoffTicket::query()->sole()->ulid, $body);
        $this->assertStringNotContainsString('+49', $body, 'the number is only inside the link, without a plus');
        $this->assertStringNotContainsString('"id"', $body);
    }

    public function test_the_text_and_the_lifetime_follow_the_settings(): void
    {
        settings()->set('whatsapp.handoff_text', 'Hello — ref :code, please!');
        settings()->set('whatsapp.handoff_ttl_minutes', 30);

        $data = $this->handoff()->assertCreated()->json('data');

        $this->assertSame('https://wa.me/4915123456789?text='.rawurlencode('Hello — ref '.$data['code'].', please!'), $data['waUrl']);
        $this->assertEqualsWithDelta(now()->addMinutes(30)->getTimestamp(), strtotime($data['expiresAt']), 5);
    }

    public function test_asking_again_returns_the_same_live_ticket_for_the_same_topic(): void
    {
        $first = $this->handoff(['category' => 'billing'])->assertCreated()->json('data');
        $again = $this->handoff(['category' => 'billing'])->assertOk()->json('data');
        $other = $this->handoff()->assertCreated()->json('data');

        $this->assertSame($first['code'], $again['code']);
        $this->assertNotSame($first['code'], $other['code'], 'no topic is a different ticket');
        $this->assertSame(2, WaHandoffTicket::query()->count());
    }

    public function test_a_used_or_expired_ticket_is_not_handed_back(): void
    {
        $first = $this->handoff()->assertCreated()->json('data');
        WaHandoffTicket::query()->where('code', $first['code'])->update(['consumed_at' => now()]);
        $second = $this->handoff()->assertCreated()->json('data');
        WaHandoffTicket::query()->where('code', $second['code'])->update(['expires_at' => now()->subSecond()]);
        $third = $this->handoff()->assertCreated()->json('data');

        $this->assertCount(3, array_unique([$first['code'], $second['code'], $third['code']]));
    }

    public function test_another_visitors_ticket_is_never_handed_out(): void
    {
        $mine = $this->handoff()->assertCreated()->json('data');
        $other = $this->visitorSession($this->widget);

        $theirs = $this->handoff(token: $other)->assertCreated()->json('data');

        $this->assertNotSame($mine['code'], $theirs['code']);
    }

    public function test_a_topic_must_be_an_active_category_of_this_widget(): void
    {
        $elsewhere = Category::factory()->create(['slug' => 'sales']);
        Category::factory()->create(['slug' => 'dormant', 'is_active' => false])->widgets()->attach($this->widget->id, ['sort_order' => 9]);

        foreach (['nope', 'sales', 'dormant', 'UPPER', '../x', str_repeat('a', 101)] as $slug) {
            $this->handoff(['category' => $slug])->assertStatus(422)->assertJsonValidationErrors('category', 'error.details');
        }

        $this->assertNotNull($elsewhere);
        $this->assertSame(0, WaHandoffTicket::query()->count());
    }

    // ---- availability gates ------------------------------------------------------------------------------------------------

    public function test_the_global_switch_and_the_published_feature_both_have_to_be_on(): void
    {
        settings()->set('whatsapp.enabled', false);
        $this->handoff()->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');

        settings()->set('whatsapp.enabled', true);
        $this->publishWhatsAppFeature($this->widget, false);
        $this->handoff()->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');

        $this->publishWhatsAppFeature($this->widget, true);
        $this->handoff()->assertCreated();
        $this->assertSame(1, WaHandoffTicket::query()->count());
    }

    public function test_a_draft_that_is_not_published_does_not_turn_the_feature_on(): void
    {
        $this->publishWhatsAppFeature($this->widget, false);
        $draft = $this->widget->draft_config;
        $draft['features']['whatsapp'] = true;
        $this->widget->forceFill(['draft_config' => $draft])->save();

        $this->handoff()->assertForbidden()->assertJsonPath('error.code', 'feature_disabled');
    }

    /**
     * @return iterable<string, array{string}>
     */
    public static function unavailableStates(): iterable
    {
        yield 'starting' => ['starting'];
        yield 'waiting for a scan' => ['qr'];
        yield 'disconnected' => ['disconnected'];
        yield 'failed' => ['failed'];
    }

    #[DataProvider('unavailableStates')]
    public function test_a_session_that_is_not_ready_cannot_take_a_hand_off(string $state): void
    {
        $this->session->forceFill(['status' => $state])->save();

        $this->handoff()->assertStatus(409)->assertJsonPath('error.code', 'whatsapp_unavailable');
        $this->assertSame(0, WaHandoffTicket::query()->count());
    }

    public function test_no_linked_session_a_deleted_one_or_one_without_a_number_is_unavailable(): void
    {
        $this->session->forceFill(['phone_e164' => null])->save();
        $this->handoff()->assertStatus(409)->assertJsonPath('error.code', 'whatsapp_unavailable');

        $this->session->forceFill(['phone_e164' => '+4915123456789'])->save();
        $this->session->delete();
        $this->handoff()->assertStatus(409)->assertJsonPath('error.code', 'whatsapp_unavailable');

        $this->widget->forceFill(['whatsapp_session_id' => null])->save();
        $this->handoff()->assertStatus(409)->assertJsonPath('error.code', 'whatsapp_unavailable');
    }

    // ---- the same gates as starting a chat ---------------------------------------------------------------------------------

    public function test_a_token_of_another_widget_or_another_key_is_widget_not_found(): void
    {
        [$other] = $this->chatWidget(slug: 'other');
        $otherToken = $this->visitorSession($other);

        $this->handoff(token: $otherToken)->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
        $this->handoff(widget: $other)->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
        $this->assertSame(0, WaHandoffTicket::query()->count());
    }

    public function test_an_unknown_key_a_disabled_widget_and_a_wrong_origin_are_refused_like_everywhere_else(): void
    {
        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer '.$this->token->plaintext])
            ->postJson('/api/v1/public/widgets/wk_unknownunknownunknown00/whatsapp-handoff')->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');

        $this->handoff(headers: ['Origin' => 'https://evil.test'])->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed');

        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->handoff()->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');
    }

    public function test_a_missing_unknown_or_revoked_token_is_a_401(): void
    {
        $url = '/api/v1/public/widgets/'.$this->widget->public_key.'/whatsapp-handoff';

        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->postJson($url)->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN, 'Authorization' => 'Bearer vt_'.str_repeat('x', 40)])->postJson($url)->assertUnauthorized();

        $this->token->session->forceFill(['revoked_at' => now()])->save();
        $this->handoff()->assertUnauthorized()->assertJsonPath('error.code', 'session_revoked');
    }

    public function test_a_staff_token_is_not_a_visitor(): void
    {
        $admin = $this->whatsAppPeopleForTokens();

        $this->withHeaders(['Origin' => self::CUSTOMER_ORIGIN])->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/public/widgets/'.$this->widget->public_key.'/whatsapp-handoff')->assertUnauthorized();
    }

    private function whatsAppPeopleForTokens(): User
    {
        return User::factory()->admin()->create();
    }

    // ---- limits ------------------------------------------------------------------------------------------------------------

    public function test_a_visitor_is_limited_per_minute_even_when_every_answer_is_the_same_ticket(): void
    {
        config(['whatsapp.handoff.rate_limits.per_visitor' => 3]);

        foreach (range(1, 3) as $ignored) {
            $this->handoff()->assertSuccessful();
        }

        $this->handoff()->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->assertSame(1, WaHandoffTicket::query()->count());
    }

    public function test_a_network_and_a_widget_have_their_own_budgets(): void
    {
        config(['whatsapp.handoff.rate_limits.per_widget' => 2, 'whatsapp.handoff.rate_limits.per_visitor' => 50, 'whatsapp.handoff.rate_limits.per_network' => 50, 'whatsapp.handoff.rate_limits.per_widget_network' => 50]);

        $this->handoff()->assertSuccessful();
        $this->handoff(token: $this->visitorSession($this->widget))->assertSuccessful();
        $this->handoff(token: $this->visitorSession($this->widget))->assertStatus(429);
    }

    public function test_one_visitor_cannot_mint_more_than_the_daily_number_of_codes(): void
    {
        $visitorId = $this->token->session->visitor_id;

        foreach (range(1, 10) as $ignored) {
            WaHandoffTicket::factory()->create([
                'widget_id' => $this->widget->id, 'visitor_id' => $visitorId, 'session_id' => $this->session->id, 'consumed_at' => now(),
            ]);
        }

        $response = $this->handoff()->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        $this->assertSame('3600', $response->headers->get('Retry-After'));
        $this->assertSame(10, WaHandoffTicket::query()->count());
        $this->assertNotNull(Visitor::query()->find($visitorId));
    }

    /** A visitor token whose session was opened from the given client network (the HMAC the real session creation stores). */
    private function visitorFrom(string $network, ?Widget $widget = null): IssuedVisitorToken
    {
        $issued = $this->visitorSession($widget ?? $this->widget);
        $issued->session->forceFill(['network_hash' => hash('sha256', $network)])->save();

        return $issued;
    }

    public function test_a_script_that_fetches_a_new_visitor_for_every_request_is_capped_per_network_and_widget(): void
    {
        config(['whatsapp.handoff.max_live_per_widget_network' => 3]);
        $limits = ['whatsapp.handoff.rate_limits.per_visitor' => 50, 'whatsapp.handoff.rate_limits.per_network' => 500, 'whatsapp.handoff.rate_limits.per_widget_network' => 500, 'whatsapp.handoff.rate_limits.per_widget' => 500];
        config($limits);

        // Three different visitors, one network: three live codes.
        foreach (range(1, 3) as $ignored) {
            $this->handoff(token: $this->visitorFrom('198.51.100.7'))->assertCreated();
        }

        $response = $this->handoff(token: $this->visitorFrom('198.51.100.7'))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        $this->assertGreaterThanOrEqual(60, (int) $response->headers->get('Retry-After'));
        $this->assertLessThanOrEqual(3600, (int) $response->headers->get('Retry-After'));
        $this->assertSame(3, WaHandoffTicket::query()->count());
        $this->assertSame(hash('sha256', '198.51.100.7'), WaHandoffTicket::query()->first()?->network_hash);

        // Another network is not affected, and neither is another widget on the same network.
        $this->handoff(token: $this->visitorFrom('203.0.113.9'))->assertCreated();
        $chatWidget = $this->enabledWidget(['customer.test'], ['offline_mode' => 'always_online'], Category::factory()->create(['slug' => 'sales']));
        $otherWidget = $this->publishWhatsAppFeature($chatWidget);
        $otherWidget->forceFill(['whatsapp_session_id' => $this->session->id])->save();
        $this->handoff(token: $this->visitorFrom('198.51.100.7', $otherWidget), widget: $otherWidget)->assertCreated();

        // A code that was used (or has expired) makes room again.
        WaHandoffTicket::query()->where('network_hash', hash('sha256', '198.51.100.7'))->where('widget_id', $this->widget->id)->orderBy('id')->first()?->forceFill(['consumed_at' => now()])->save();
        $this->handoff(token: $this->visitorFrom('198.51.100.7'))->assertCreated();
        WaHandoffTicket::query()->where('network_hash', hash('sha256', '198.51.100.7'))->where('widget_id', $this->widget->id)->whereNull('consumed_at')->orderBy('id')->first()?->forceFill(['expires_at' => now()->subSecond()])->save();
        $this->handoff(token: $this->visitorFrom('198.51.100.7'))->assertCreated();
    }

    public function test_a_visitor_at_the_cap_still_gets_their_own_live_code_back(): void
    {
        config(['whatsapp.handoff.max_live_per_widget_network' => 1, 'whatsapp.handoff.max_live_per_widget' => 1]);
        $mine = $this->visitorFrom('198.51.100.7');
        $first = $this->handoff(token: $mine)->assertCreated()->json('data.code');

        $this->handoff(token: $mine)->assertOk()->assertJsonPath('data.code', $first);
        $this->handoff(token: $this->visitorFrom('198.51.100.7'))->assertStatus(429);
    }

    public function test_a_widget_has_a_ceiling_of_live_codes_whatever_the_networks(): void
    {
        config(['whatsapp.handoff.max_live_per_widget' => 2]);

        $this->handoff(token: $this->visitorFrom('198.51.100.1'))->assertCreated();
        $this->handoff(token: $this->visitorFrom('198.51.100.2'))->assertCreated();
        $this->handoff(token: $this->visitorFrom('198.51.100.3'))->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');

        $this->assertSame(2, WaHandoffTicket::query()->count());
    }

    public function test_the_defaults_leave_room_for_a_busy_office(): void
    {
        $this->assertSame(30, config('whatsapp.handoff.max_live_per_widget_network'));
        $this->assertSame(500, config('whatsapp.handoff.max_live_per_widget'));
    }

    public function test_the_route_sets_no_cookie_and_needs_no_csrf(): void
    {
        $response = $this->handoff()->assertCreated();

        $this->assertSame([], $response->headers->getCookies());
    }
}
