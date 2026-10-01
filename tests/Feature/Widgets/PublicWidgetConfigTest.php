<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Actions\PublishWidget;
use App\Domain\Widgets\Data\WidgetTexts;
use App\Domain\Widgets\Support\AppOrigin;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;
use App\Models\WidgetGreeting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class PublicWidgetConfigTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase, WidgetFixtures;

    private Widget $widget;

    protected function setUp(): void
    {
        parent::setUp();

        $this->widget = $this->enabledWidget(['customer.test', '*.shop.test', 'localhost:5174']);
        $this->widget->greetings()->create(['body' => 'Hello from Sara', 'agent_name' => 'Sara', 'weight' => 2, 'sort_order' => 0]);
    }

    private function configUrl(?string $key = null, string $query = ''): string
    {
        return '/api/v1/public/widgets/'.($key ?? $this->widget->public_key).'/config'.$query;
    }

    /**
     * @param  array<string, string>  $headers
     */
    private function fetch(string $url, array $headers = []): TestResponse
    {
        return $this->withHeaders($headers)->getJson($url);
    }

    public function test_a_whitelisted_origin_gets_the_resolved_boot_config(): void
    {
        $response = $this->fetch($this->configUrl(), ['Origin' => 'https://customer.test']);

        $response->assertOk()
            ->assertHeader('Access-Control-Allow-Origin', 'https://customer.test')
            ->assertHeader('Vary', 'Origin')
            ->assertHeader('ETag')
            ->assertJsonPath('data.v', 1)
            ->assertJsonPath('data.key', $this->widget->public_key)
            ->assertJsonPath('data.configVersion', 1)
            ->assertJsonPath('data.locale', 'en')
            ->assertJsonPath('data.api.appOrigin', app(AppOrigin::class)->url())
            ->assertJsonPath('data.api.base', app(AppOrigin::class)->url().'/api/v1/public')
            ->assertJsonPath('data.api.embed', app(AppOrigin::class)->url().'/embed/'.$this->widget->public_key)
            ->assertJsonPath('data.config.theme.primary', '#0f766e')
            ->assertJsonPath('data.config.texts.en.title', 'Support')
            ->assertJsonPath('data.categories.0.slug', 'billing')
            ->assertJsonPath('data.categories.0.label', 'Billing')
            ->assertJsonPath('data.greetings.0.body', 'Hello from Sara')
            ->assertJsonPath('data.greetings.0.agentName', 'Sara')
            ->assertJsonPath('data.greetings.0.weight', 2)
            ->assertJsonPath('data.availability.openNow', fn ($value) => is_bool($value))
            ->assertJsonPath('data.availability.whatsapp.enabled', false);

        $this->assertCacheControl($response, ['public', 'max-age=60', 'stale-while-revalidate=300']);
        $this->assertMatchesRegularExpression('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/', (string) $response->json('data.generatedAt'));
    }

    public function test_server_side_policy_never_reaches_visitors(): void
    {
        $data = $this->fetch($this->configUrl(), ['Origin' => 'https://customer.test'])->assertOk()->json('data');

        $this->assertArrayNotHasKey('routing', $data['config']);
        $this->assertArrayNotHasKey('session', $data['config']);
        $this->assertArrayHasKey('hours', $data['config']);
        $this->assertFalse($data['config']['features']['whatsapp'], 'WhatsApp is only offered once a session is connected (P6)');
        $this->assertNoIntegerIds($data);
        $this->assertNoSecrets($data);
    }

    public function test_the_response_carries_ulid_or_key_identifiers_only(): void
    {
        $data = $this->fetch($this->configUrl(), ['Origin' => 'https://customer.test'])->json('data');

        $this->assertSame($this->widget->public_key, $data['key']);
        $this->assertSame($this->widget->greetings()->first()?->ulid, $data['greetings'][0]['id']);
        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', $data['greetings'][0]['id']);
    }

    public function test_wildcards_ports_and_the_installations_own_origin_are_allowed(): void
    {
        $this->fetch($this->configUrl(), ['Origin' => 'https://eu.shop.test'])->assertOk()->assertHeader('Access-Control-Allow-Origin', 'https://eu.shop.test');
        $this->fetch($this->configUrl(), ['Origin' => 'http://localhost:5174'])->assertOk();
        $this->fetch($this->configUrl(), ['Origin' => app(AppOrigin::class)->url()])->assertOk();
    }

    /**
     * @return array<string, array{0: string}>
     */
    public static function rejectedOrigins(): array
    {
        return [
            'unrelated site' => ['https://evil.example'],
            'null origin' => ['null'],
            'look-alike of a wildcard' => ['https://evil-shop.test'],
            'apex of a wildcard' => ['https://shop.test'],
            'suffix trick' => ['https://customer.test.evil.example'],
            'userinfo trick' => ['https://customer.test@evil.example'],
            'other port' => ['https://customer.test:8443'],
            'path in origin' => ['https://customer.test/page'],
            'localhost on the wrong port' => ['http://localhost:5175'],
            'empty origin' => [''],
        ];
    }

    #[DataProvider('rejectedOrigins')]
    public function test_other_origins_are_refused_without_cors_headers(string $origin): void
    {
        $response = $this->fetch($this->configUrl(), ['Origin' => $origin]);

        $response->assertForbidden()
            ->assertJsonPath('error.code', 'origin_not_allowed')
            ->assertHeader('Vary', 'Origin')
            ->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $response->assertJsonMissingPath('data');
    }

    public function test_requests_without_an_origin_need_the_non_browser_flag(): void
    {
        $this->fetch($this->configUrl())->assertForbidden()->assertJsonPath('error.code', 'origin_not_allowed');

        $this->widget->forceFill(['allow_non_browser_clients' => true])->save();

        $this->fetch($this->configUrl())->assertOk()->assertHeaderMissing('Access-Control-Allow-Origin');
        // A browser origin is still checked when it is sent.
        $this->fetch($this->configUrl(), ['Origin' => 'https://evil.example'])->assertForbidden();
    }

    public function test_the_browser_can_vouch_for_same_origin_requests(): void
    {
        $this->fetch($this->configUrl(), ['Sec-Fetch-Site' => 'same-origin'])->assertOk();
        $this->fetch($this->configUrl(), ['Sec-Fetch-Site' => 'cross-site'])->assertForbidden();
        $this->fetch($this->configUrl(), ['Sec-Fetch-Site' => 'none'])->assertForbidden();
    }

    public function test_unknown_malformed_disabled_and_deleted_widgets_are_404(): void
    {
        $headers = ['Origin' => 'https://customer.test'];

        $this->fetch($this->configUrl('wk_doesnotexist0000000000'), $headers)
            ->assertNotFound()
            ->assertJsonPath('error.code', 'widget_not_found')
            ->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->fetch($this->configUrl('not-a-key'), $headers)->assertNotFound();
        $this->fetch($this->configUrl(strtoupper($this->widget->public_key)), $headers)->assertNotFound();

        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->fetch($this->configUrl(), $headers)->assertNotFound()->assertJsonPath('error.code', 'widget_not_found');

        $this->widget->forceFill(['is_enabled' => true])->save();
        $this->fetch($this->configUrl(), $headers)->assertOk();

        $this->widget->delete();
        $this->fetch($this->configUrl(), $headers)->assertNotFound();
    }

    public function test_etag_and_conditional_requests(): void
    {
        $headers = ['Origin' => 'https://customer.test'];

        $first = $this->fetch($this->configUrl(), $headers)->assertOk();
        $etag = (string) $first->headers->get('ETag');
        $this->assertNotSame('', $etag);

        $second = $this->fetch($this->configUrl(), $headers + ['If-None-Match' => $etag]);
        $second->assertStatus(304)
            ->assertHeader('ETag', $etag)
            ->assertHeader('Access-Control-Allow-Origin', 'https://customer.test')
            ->assertHeader('Vary', 'Origin');
        $this->assertCacheControl($second, ['public', 'max-age=60', 'stale-while-revalidate=300']);
        $this->assertSame('', $second->getContent());

        // The tag is stable between requests even though generatedAt differs, and changes when the content does.
        $this->travel(5)->seconds();
        $this->fetch($this->configUrl(), $headers + ['If-None-Match' => $etag])->assertStatus(304);

        $this->widget->greetings()->create(['body' => 'A brand new greeting', 'sort_order' => 1]);
        app(WidgetCache::class)->bust($this->widget);
        $changed = $this->fetch($this->configUrl(), $headers + ['If-None-Match' => $etag])->assertOk();
        $this->assertNotSame($etag, $changed->headers->get('ETag'));
    }

    public function test_publishing_changes_the_served_config_and_bumps_the_version(): void
    {
        $headers = ['Origin' => 'https://customer.test'];
        $before = $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->assertSame('#0f766e', $before->json('data.config.theme.primary'));

        $draft = $this->widget->draft_config;
        $draft['theme']['primary'] = '#123456';
        $this->widget->forceFill(['draft_config' => $draft])->save();

        $this->fetch($this->configUrl(), $headers)->assertJsonPath('data.config.theme.primary', '#0f766e');

        app(PublishWidget::class)->handle($this->widget);

        $after = $this->fetch($this->configUrl(), $headers)->assertOk();
        $after->assertJsonPath('data.config.theme.primary', '#123456')->assertJsonPath('data.configVersion', 2);
        $this->assertNotSame($before->headers->get('ETag'), $after->headers->get('ETag'));
    }

    public function test_preflight_for_an_allowed_origin(): void
    {
        $response = $this->withHeaders([
            'Origin' => 'https://customer.test',
            'Access-Control-Request-Method' => 'GET',
            'Access-Control-Request-Headers' => 'If-None-Match, X-Evil, Accept',
        ])->options($this->configUrl());

        $response->assertNoContent()
            ->assertHeader('Access-Control-Allow-Origin', 'https://customer.test')
            ->assertHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
            ->assertHeader('Access-Control-Allow-Headers', 'accept, if-none-match')
            ->assertHeader('Access-Control-Max-Age', '600');
        $this->assertStringContainsString('Origin', (string) $response->headers->get('Vary'));
    }

    public function test_preflight_for_another_origin_is_refused(): void
    {
        $this->withHeaders(['Origin' => 'https://evil.example', 'Access-Control-Request-Method' => 'GET'])
            ->options($this->configUrl())
            ->assertForbidden()
            ->assertHeaderMissing('Access-Control-Allow-Origin')
            ->assertHeaderMissing('Access-Control-Allow-Methods');

        $this->withHeaders(['Origin' => 'https://evil.example'])
            ->options('/api/v1/public/widgets/wk_doesnotexist0000000000/availability')
            ->assertNotFound();
    }

    public function test_no_cookie_or_session_is_ever_set(): void
    {
        $response = $this->fetch($this->configUrl(), ['Origin' => 'https://customer.test'])->assertOk();

        $this->assertSame([], $response->headers->getCookies());
        $this->assertNull($response->headers->get('Set-Cookie'));
    }

    public function test_the_locale_parameter_selects_texts_with_fallbacks(): void
    {
        $draft = $this->widget->draft_config;
        $draft['texts']['ar'] = ['title' => 'الدعم'];
        $draft['texts']['pt-BR'] = ['title' => 'Ajuda', 'send' => 'Enviar'];
        $this->widget->forceFill(['draft_config' => $draft, 'config' => $draft])->save();
        $this->widget->greetings()->create(['body' => 'مرحبا', 'locale' => 'ar', 'sort_order' => 1]);
        $this->widget->greetings()->create(['body' => 'Olá', 'locale' => 'pt-BR', 'sort_order' => 2]);

        $headers = ['Origin' => 'https://customer.test'];

        $all = $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->assertEqualsCanonicalizing(['en', 'ar', 'pt-BR'], array_keys($all->json('data.config.texts')));
        $this->assertSame('en', $all->json('data.locale'));
        $this->assertSame(WidgetTexts::ENGLISH['welcome'], $all->json('data.config.texts.ar.welcome'), 'missing keys fall back to english');

        $arabic = $this->fetch($this->configUrl(query: '?locale=ar-SA'), $headers)->assertOk();
        $this->assertSame('ar', $arabic->json('data.locale'));
        $this->assertEqualsCanonicalizing(['en', 'ar'], array_keys($arabic->json('data.config.texts')));
        $this->assertSame('الدعم', $arabic->json('data.config.texts.ar.title'));
        $this->assertEqualsCanonicalizing(['Hello from Sara', 'مرحبا'], array_column($arabic->json('data.greetings'), 'body'), 'greetings: matching language plus locale-less ones');

        $portuguese = $this->fetch($this->configUrl(query: '?locale=pt'), $headers)->assertOk();
        $this->assertSame('pt-BR', $portuguese->json('data.locale'));
        $this->assertSame('Enviar', $portuguese->json('data.config.texts.pt-BR.send'));

        // A locale the widget has no content for gets the default locale (and only that).
        $unknown = $this->fetch($this->configUrl(query: '?locale=zz'), $headers)->assertOk();
        $this->assertSame('en', $unknown->json('data.locale'));
        $this->assertSame(['en'], array_keys($unknown->json('data.config.texts')));
        $this->assertSame(['Hello from Sara'], array_column($unknown->json('data.greetings'), 'body'), 'only locale-less greetings');

        $garbage = $this->fetch($this->configUrl(query: '?locale=%3Cscript%3E'), $headers)->assertOk();
        $this->assertSame('en', $garbage->json('data.locale'));
        $this->assertEqualsCanonicalizing(['en', 'ar', 'pt-BR'], array_keys($garbage->json('data.config.texts')), 'not a locale: ignored');
        $this->fetch($this->configUrl(query: '?locale[]=ar'), $headers)->assertOk()->assertJsonPath('data.locale', 'en');
    }

    public function test_the_loaders_accessibility_texts_reach_every_locale(): void
    {
        $draft = $this->widget->draft_config;
        $draft['texts']['ar'] = ['title' => 'الدعم', 'closeChat' => 'إغلاق المحادثة'];
        $draft['hours']['holidays'] = [['date' => '2026-12-25', 'label' => null], ['date' => '2026-12-26', 'label' => 'Boxing Day']];
        $this->widget->forceFill(['draft_config' => $draft, 'config' => $draft])->save();
        app(WidgetCache::class)->bust($this->widget);
        $headers = ['Origin' => 'https://customer.test'];

        $all = $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->assertSame('Close chat', $all->json('data.config.texts.en.closeChat'));
        $this->assertSame('unread messages', $all->json('data.config.texts.en.unread'));
        $this->assertSame('Dismiss', $all->json('data.config.texts.en.dismiss'));
        $this->assertSame('إغلاق المحادثة', $all->json('data.config.texts.ar.closeChat'), 'translated');
        $this->assertSame('Dismiss', $all->json('data.config.texts.ar.dismiss'), 'untranslated keys fall back to english');
        $this->assertSame(['', 'Boxing Day'], array_column($all->json('data.config.hours.holidays'), 'label'), 'a holiday label is a string, never null');
    }

    public function test_inactive_and_deleted_categories_are_not_offered(): void
    {
        $inactive = Category::factory()->inactive()->create(['slug' => 'hidden']);
        $deleted = Category::factory()->create(['slug' => 'gone']);
        $second = Category::factory()->create(['slug' => 'sales', 'name' => 'Sales', 'name_i18n' => ['ar' => 'المبيعات']]);
        $this->widget->categories()->attach([$inactive->id => ['sort_order' => 1], $deleted->id => ['sort_order' => 2], $second->id => ['sort_order' => 3]]);
        $deleted->delete();

        $response = $this->fetch($this->configUrl(query: '?locale=ar'), ['Origin' => 'https://customer.test'])->assertOk();

        $this->assertSame(['billing', 'sales'], array_column($response->json('data.categories'), 'slug'));
        $this->assertSame('المبيعات', $response->json('data.categories.1.label'));
    }

    public function test_inactive_greetings_are_not_served(): void
    {
        WidgetGreeting::factory()->inactive()->for($this->widget)->create(['body' => 'Hidden greeting']);

        $bodies = array_column($this->fetch($this->configUrl(), ['Origin' => 'https://customer.test'])->json('data.greetings'), 'body');

        $this->assertSame(['Hello from Sara'], $bodies);
    }

    public function test_the_public_config_limiter_is_enforced_with_the_documented_envelope(): void
    {
        config(['chat.rate_limits.public_ip' => 3]);
        $headers = ['Origin' => 'https://customer.test'];

        $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->fetch($this->configUrl(), $headers)->assertOk();
        $this->fetch($this->configUrl(), $headers)
            ->assertStatus(429)
            ->assertJsonPath('error.code', 'rate_limited')
            ->assertHeader('Retry-After');
        // More cases (shared across keys, IPv6, 429 + CORS, unknown keys): PublicWidgetRateLimitTest.
    }
}
