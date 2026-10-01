<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Routing\Route;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Testing\TestResponse;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The limits of the public widget endpoints: a per-network limiter that does not depend on the widget key and runs before
 * the key is looked up, a budget per widget that only allowed callers can use up, a cheap path for unknown keys, and 429s
 * that the allowed origin's JavaScript can read.
 */
class PublicWidgetRateLimitTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private const ALLOWED = 'https://customer.test';

    private Widget $widget;

    private Category $category;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        $this->widget = $this->enabledWidget(['customer.test', 'other.test']);
        $this->category = Category::query()->firstOrFail();
    }

    private function configUrl(?string $key = null): string
    {
        return '/api/v1/public/widgets/'.($key ?? $this->widget->public_key).'/config';
    }

    /**
     * @param  array<string, string>  $headers
     */
    private function fetch(string $url, array $headers = [], string $ip = '203.0.113.7'): TestResponse
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $ip])->withHeaders($headers)->getJson($url);
    }

    /**
     * @param  array<string, int>  $limits
     */
    private function limits(array $limits): void
    {
        config(['chat.rate_limits' => $limits + [
            'public_ip' => 10_000,
            'public_unknown_keys' => 10_000,
            'public_widget_ip' => 10_000,
            'public_widget_origin' => 10_000,
        ]]);
    }

    /**
     * @return list<string>
     */
    private function widgetSelects(callable $callback): array
    {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $callback();
        DB::disableQueryLog();

        return array_values(array_filter(
            array_map(fn (array $query): string => (string) $query['query'], DB::getQueryLog()),
            fn (string $sql): bool => str_contains($sql, 'from "widgets"'),
        ));
    }

    // ---- the per-network limiter ---------------------------------------------------------------------------------

    public function test_the_network_limiter_does_not_depend_on_the_widget_key(): void
    {
        $limiter = RateLimiter::limiter('public-config');
        $request = fn (string $key, string $ip): Request => Request::create('/api/v1/public/widgets/'.$key.'/config', 'GET', server: ['REMOTE_ADDR' => $ip]);

        $first = $limiter($request('wk_aaaaaaaaaaaaaaaaaaaa', '203.0.113.9'));
        $second = $limiter($request('wk_bbbbbbbbbbbbbbbbbbbb', '203.0.113.9'));
        $other = $limiter($request('wk_aaaaaaaaaaaaaaaaaaaa', '203.0.113.10'));

        $this->assertInstanceOf(Limit::class, $first);
        $this->assertInstanceOf(Limit::class, $second);
        $this->assertInstanceOf(Limit::class, $other);
        $this->assertSame(600, $first->maxAttempts);
        $this->assertSame($first->key, $second->key, 'random keys must not get a bucket of their own');
        $this->assertNotSame($first->key, $other->key);
    }

    public function test_the_per_widget_limiter_has_two_budgets_keyed_by_network_and_by_allowed_origin(): void
    {
        $request = Request::create('/api/v1/public/widgets/wk_aaaaaaaaaaaaaaaaaaaa/config', 'GET', server: ['REMOTE_ADDR' => '203.0.113.9']);
        $request->setRouteResolver(fn () => (new Route('GET', '/api/v1/public/widgets/{key}/config', []))->bind($request));
        $request->attributes->set('widget_origin', self::ALLOWED);

        /** @var list<Limit> $limits */
        $limits = RateLimiter::limiter('public-config-widget')($request);

        $this->assertSame([300, 6000], array_map(fn (Limit $limit): int => $limit->maxAttempts, $limits));
        $this->assertStringContainsString('203.0.113.9', $limits[0]->key);
        $this->assertStringContainsString(self::ALLOWED, $limits[1]->key);
    }

    public function test_one_address_is_limited_across_all_widget_keys(): void
    {
        $this->limits(['public_ip' => 3]);
        $second = $this->enabledWidget(['customer.test'], category: $this->category);
        $headers = ['Origin' => self::ALLOWED];

        $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->fetch($this->configUrl($second->public_key), $headers)->assertOk();
        $this->fetch($this->configUrl(), $headers)->assertOk();

        $this->fetch($this->configUrl($second->public_key), $headers)
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After');
        // Another address is unaffected.
        $this->fetch($this->configUrl(), $headers, '203.0.113.8')->assertOk();
    }

    public function test_an_ipv6_network_shares_one_bucket(): void
    {
        $this->limits(['public_ip' => 3]);
        $headers = ['Origin' => self::ALLOWED];

        $this->fetch($this->configUrl(), $headers, '2001:db8:1:2::1')->assertOk();
        $this->fetch($this->configUrl(), $headers, '2001:db8:1:2:ffff::2')->assertOk();
        $this->fetch($this->configUrl(), $headers, '2001:db8:1:2:1234:5678:9abc:def0')->assertOk();

        $this->fetch($this->configUrl(), $headers, '2001:db8:1:2::4')->assertStatus(429);
        $this->fetch($this->configUrl(), $headers, '2001:db8:1:3::1')->assertOk();
    }

    public function test_the_network_limit_is_checked_before_the_key_is_looked_up(): void
    {
        $this->limits(['public_ip' => 1]);

        $this->fetch($this->configUrl('wk_neverexisted00000000'))->assertNotFound();

        $selects = $this->widgetSelects(fn () => $this->fetch($this->configUrl($this->widget->public_key), ['Origin' => self::ALLOWED])->assertStatus(429));

        $this->assertSame([], $selects, 'a throttled request must not touch the widgets table');
    }

    public function test_the_loader_and_iframe_pages_share_the_network_limit(): void
    {
        $this->limits(['public_ip' => 2]);
        $key = $this->widget->public_key;

        $this->get('/w/'.$key.'.js')->assertOk();
        $this->get('/embed/'.$key)->assertOk();

        $this->get('/c/'.$key)->assertStatus(429)->assertHeader('Retry-After');
    }

    // ---- unknown keys ----------------------------------------------------------------------------------------------

    public function test_probing_unknown_keys_is_throttled_per_network(): void
    {
        $this->limits(['public_unknown_keys' => 3]);

        foreach (range(1, 3) as $i) {
            $this->fetch($this->configUrl('wk_probe'.str_pad((string) $i, 14, '0')), ['Origin' => self::ALLOWED])->assertNotFound();
        }

        $this->fetch($this->configUrl('wk_probe99999999999999'), ['Origin' => self::ALLOWED])
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After');
        // The probing network is shut out, others are not; and valid keys of other networks work.
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED], '203.0.113.99')->assertOk();
    }

    public function test_embed_pages_of_unknown_keys_count_as_probes_too(): void
    {
        $this->limits(['public_unknown_keys' => 2]);

        $this->get('/c/wk_doesnotexist0000000000')->assertNotFound();
        $this->get('/embed/wk_doesnotexist0000000001')->assertNotFound();
        $this->get('/w/wk_doesnotexist0000000002.js')->assertStatus(429);
    }

    public function test_a_unknown_key_is_looked_up_once_and_then_remembered_for_a_while(): void
    {
        $key = 'wk_randomprobe00000000';

        $first = $this->widgetSelects(fn () => $this->fetch($this->configUrl($key))->assertNotFound());
        $again = $this->widgetSelects(fn () => $this->fetch($this->configUrl($key))->assertNotFound());

        $this->assertNotSame([], $first);
        $this->assertSame([], $again, 'the second probe of the same key is answered from the cache');

        $this->travel(WidgetCache::UNKNOWN_KEY_SECONDS + 1)->seconds();
        $this->assertNotSame([], $this->widgetSelects(fn () => $this->fetch($this->configUrl($key))->assertNotFound()));
    }

    public function test_a_widget_created_with_a_remembered_key_is_found_at_once(): void
    {
        $key = 'wk_createdlater00000000';
        $this->fetch($this->configUrl($key), ['Origin' => self::ALLOWED])->assertNotFound();

        Widget::factory()->enabled()->withDomains(['customer.test'])->create(['public_key' => $key]);

        $this->fetch($this->configUrl($key), ['Origin' => self::ALLOWED])->assertOk();
    }

    public function test_a_disabled_widget_is_not_remembered_as_unknown(): void
    {
        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertNotFound();

        $this->widget->forceFill(['is_enabled' => true])->save();

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
    }

    // ---- the per-widget budget ---------------------------------------------------------------------------------------

    public function test_only_callers_that_passed_the_origin_check_use_up_the_widget_budget(): void
    {
        $this->limits(['public_widget_origin' => 2]);

        // A flood from a website that is not allowed: refused, and the budget stays untouched.
        foreach (range(1, 6) as $i) {
            $this->fetch($this->configUrl(), ['Origin' => 'https://evil.example'], '198.51.100.'.$i)->assertForbidden();
        }
        // ... and so is one without any Origin when the widget does not allow non-browser clients.
        $this->fetch($this->configUrl())->assertForbidden();

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertStatus(429);
        // Each allowed origin has its own budget.
        $this->fetch($this->configUrl(), ['Origin' => 'https://other.test'])->assertOk();
    }

    public function test_the_per_address_widget_budget_also_counts_only_allowed_callers(): void
    {
        $this->limits(['public_widget_ip' => 2]);

        foreach (range(1, 4) as $unused) {
            $this->fetch($this->configUrl(), ['Origin' => 'https://evil.example'])->assertForbidden();
        }

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertStatus(429);
    }

    // ---- CORS on 429 -------------------------------------------------------------------------------------------------

    public function test_a_widget_budget_429_carries_the_cors_headers_of_the_allowed_origin(): void
    {
        $this->limits(['public_widget_origin' => 1]);

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After')
            ->assertHeader('Access-Control-Allow-Origin', self::ALLOWED)
            ->assertHeader('Access-Control-Expose-Headers', 'Retry-After')
            ->assertHeader('Vary', 'Origin');
    }

    public function test_a_network_429_carries_the_cors_headers_for_an_allowed_origin_only(): void
    {
        $this->limits(['public_ip' => 2]);
        $other = $this->enabledWidget(['customer.test'], category: $this->category);

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();

        // The allowed origin can read the 429 (and its Retry-After) ...
        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])
            ->assertStatus(429)
            ->assertHeader('Retry-After')
            ->assertHeader('Access-Control-Allow-Origin', self::ALLOWED)
            ->assertHeader('Access-Control-Expose-Headers', 'Retry-After');
        $this->fetch('/api/v1/public/widgets/'.$this->widget->public_key.'/availability', ['Origin' => self::ALLOWED])
            ->assertStatus(429)
            ->assertHeader('Access-Control-Allow-Origin', self::ALLOWED);

        // ... nobody else can: not another website, not a caller without Origin, not an origin never seen for this widget.
        $this->fetch($this->configUrl(), ['Origin' => 'https://evil.example'])->assertStatus(429)->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->fetch($this->configUrl())->assertStatus(429)->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->fetch($this->configUrl($other->public_key), ['Origin' => self::ALLOWED])->assertStatus(429)->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->fetch($this->configUrl(), ['Origin' => 'https://other.test'])->assertStatus(429)->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_a_probing_429_carries_cors_headers_only_for_an_origin_the_widget_allowed_before(): void
    {
        $this->limits(['public_unknown_keys' => 1]);

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED], '203.0.113.50')->assertOk();
        $this->fetch($this->configUrl('wk_probe00000000000001'), ['Origin' => self::ALLOWED], '203.0.113.50')->assertNotFound();

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED], '203.0.113.50')
            ->assertStatus(429)
            ->assertHeader('Access-Control-Allow-Origin', self::ALLOWED);
        $this->fetch($this->configUrl(), ['Origin' => 'https://evil.example'], '203.0.113.50')
            ->assertStatus(429)
            ->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_a_preflight_does_not_use_up_the_widget_budget(): void
    {
        $this->limits(['public_widget_origin' => 1]);

        foreach (range(1, 3) as $unused) {
            $this->withHeaders(['Origin' => self::ALLOWED, 'Access-Control-Request-Method' => 'GET'])->options($this->configUrl())->assertNoContent();
        }

        $this->fetch($this->configUrl(), ['Origin' => self::ALLOWED])->assertOk();
    }
}
