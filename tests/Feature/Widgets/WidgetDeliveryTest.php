<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Actions\PublishWidget;
use App\Domain\Widgets\Embed\LoaderBundle;
use App\Domain\Widgets\Support\AppOrigin;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Testing\TestResponse;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class WidgetDeliveryTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private const LOADER_CODE = '/* loader v1 */(function(){window.__loaderRan=true;})();';

    private Widget $widget;

    private string $loaderPath;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        $this->widget = $this->enabledWidget(['customer.test', '*.shop.test']);
        $this->widget->greetings()->create(['body' => 'Hi there', 'agent_name' => 'Sara', 'sort_order' => 0]);

        $this->loaderPath = sys_get_temp_dir().'/pne-loader-'.bin2hex(random_bytes(6)).'.js';
        file_put_contents($this->loaderPath, self::LOADER_CODE);
        $this->useLoader($this->loaderPath);
    }

    protected function tearDown(): void
    {
        @unlink($this->loaderPath);

        parent::tearDown();
    }

    private function useLoader(string $path): void
    {
        $this->app->instance(LoaderBundle::class, new LoaderBundle($path));
    }

    private function script(?string $key = null): TestResponse
    {
        return $this->get('/w/'.($key ?? $this->widget->public_key).'.js');
    }

    /**
     * @return array<string, mixed>
     */
    private function bootFrom(TestResponse $response): array
    {
        $this->assertSame(1, preg_match('/^\(function\(\)\{var b=\(window\.__PNE_CHAT_BOOT__=window\.__PNE_CHAT_BOOT__\|\|\{\}\);b\["([^"]+)"\]=(\{.*\});\}\)\(\);$/m', $response->getContent(), $matches), 'prelude not found');
        $this->assertSame($this->widget->public_key, $matches[1]);

        /** @var array<string, mixed> $boot */
        $boot = json_decode($matches[2], true, flags: JSON_THROW_ON_ERROR);

        return $boot;
    }

    public function test_the_widget_script_inlines_the_boot_config_then_the_loader(): void
    {
        $response = $this->script();

        $response->assertOk()
            ->assertHeader('Content-Type', 'application/javascript; charset=utf-8')
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('ETag');
        $this->assertCacheControl($response, ['public', 'max-age=60', 'stale-while-revalidate=300']);

        $content = $response->getContent();
        $this->assertStringStartsWith('(function(){var b=(window.__PNE_CHAT_BOOT__=window.__PNE_CHAT_BOOT__||{});b["'.$this->widget->public_key.'"]=', $content);
        $this->assertStringEndsWith("\n".self::LOADER_CODE, $content);

        $boot = $this->bootFrom($response);
        $this->assertSame($this->widget->public_key, $boot['key']);
        $this->assertSame(1, $boot['configVersion']);
        $this->assertSame('Hi there', $boot['greetings'][0]['body']);
        $this->assertSame('billing', $boot['categories'][0]['slug']);
        $this->assertSame(app(AppOrigin::class)->url(), $boot['api']['appOrigin']);
        $this->assertArrayNotHasKey('routing', $boot['config']);
    }

    public function test_the_boot_config_equals_what_the_config_endpoint_returns(): void
    {
        $inline = $this->bootFrom($this->script());

        $api = $this->withHeaders(['Origin' => 'https://customer.test'])
            ->getJson('/api/v1/public/widgets/'.$this->widget->public_key.'/config')
            ->assertOk()
            ->json('data');

        unset($inline['generatedAt'], $api['generatedAt']);
        $this->assertSame($api, $inline);
    }

    public function test_no_cookie_is_set_even_when_the_visitor_sends_one(): void
    {
        $response = $this->withUnencryptedCookie('laravel_session', 'whatever')->withUnencryptedCookie('XSRF-TOKEN', 'x')->get('/w/'.$this->widget->public_key.'.js');

        $response->assertOk();
        $this->assertSame([], $response->headers->getCookies());
        $this->assertNull($response->headers->get('Set-Cookie'));

        $generic = $this->get('/widget/v1/loader.js');
        $this->assertSame([], $generic->headers->getCookies());
    }

    public function test_the_script_cannot_be_broken_out_of_by_greeting_text(): void
    {
        $this->widget->greetings()->create(['body' => "</script><script>alert(1)</script> \u{2028} <!-- ", 'sort_order' => 1]);

        $response = $this->script();
        $content = $response->getContent();

        // The only place a closing tag may occur is inside the (escaped) JSON string, never raw.
        $this->assertStringNotContainsString('</script>', $content);
        $this->assertStringNotContainsString("\u{2028}", $content);
        $this->assertSame("</script><script>alert(1)</script> \u{2028} <!-- ", $this->bootFrom($response)['greetings'][1]['body']);
    }

    public function test_a_missing_loader_bundle_degrades_to_the_prelude_and_a_console_warning(): void
    {
        $this->useLoader('/nonexistent/path/loader.js');

        $response = $this->script()->assertOk();

        $this->assertSame($this->widget->public_key, $this->bootFrom($response)['key']);
        $this->assertStringContainsString('console.warn', $response->getContent());
        $this->assertStringContainsString('npm run build:widget', $response->getContent());
    }

    public function test_conditional_requests_and_etag_changes(): void
    {
        // The boot config carries the widget's availability, which flips at the default opening hours (09:00 and 17:00 UTC on
        // weekdays): pin the clock to the middle of an opening day so that `travel(30)` never crosses one of those instants
        // (the test failed whenever it ran in the half minute before 09:00 or 17:00 UTC).
        $this->travelTo(Carbon::parse('2026-03-04 12:00:00', 'UTC'));

        $first = $this->script()->assertOk();
        $etag = (string) $first->headers->get('ETag');

        $revalidated = $this->withHeaders(['If-None-Match' => $etag])->get('/w/'.$this->widget->public_key.'.js');
        $revalidated->assertStatus(304)->assertHeader('ETag', $etag);
        $this->assertCacheControl($revalidated, ['public', 'max-age=60', 'stale-while-revalidate=300']);
        $this->assertSame('', $revalidated->getContent());

        // generatedAt moves, the tag does not.
        $this->travel(30)->seconds();
        $this->withHeaders(['If-None-Match' => $etag])->get('/w/'.$this->widget->public_key.'.js')->assertStatus(304);

        // Publishing a change moves the tag.
        $draft = $this->widget->draft_config;
        $draft['theme']['primary'] = '#654321';
        $this->widget->forceFill(['draft_config' => $draft])->save();
        app(PublishWidget::class)->handle($this->widget);
        $afterPublish = $this->withHeaders(['If-None-Match' => $etag])->get('/w/'.$this->widget->public_key.'.js')->assertOk();
        $this->assertNotSame($etag, $afterPublish->headers->get('ETag'));
        $this->assertSame('#654321', $this->bootFrom($afterPublish)['config']['theme']['primary']);

        // Rebuilding the loader moves it too.
        $etag = (string) $afterPublish->headers->get('ETag');
        file_put_contents($this->loaderPath, self::LOADER_CODE.' /* rebuilt with more code */');
        touch($this->loaderPath, time() + 10);
        $this->assertNotSame($etag, $this->script()->headers->get('ETag'));
    }

    public function test_unknown_malformed_disabled_and_deleted_widgets_are_404(): void
    {
        $this->script('wk_doesnotexist0000000000')->assertNotFound()->assertHeader('Content-Type', 'application/javascript; charset=utf-8')->assertHeader('Cache-Control', 'no-store, private');
        $this->get('/w/not-a-key.js')->assertNotFound();
        $this->script(strtoupper($this->widget->public_key))->assertNotFound();

        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->script()->assertNotFound();

        $this->widget->forceFill(['is_enabled' => true])->save();
        $this->script()->assertOk();

        $this->widget->delete();
        $this->script()->assertNotFound();
    }

    public function test_the_generic_loader_is_the_bundle_without_a_boot_config(): void
    {
        $response = $this->get('/widget/v1/loader.js');

        $response->assertOk()
            ->assertHeader('Content-Type', 'application/javascript; charset=utf-8')
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('ETag');
        $this->assertCacheControl($response, ['public', 'max-age=60', 'stale-while-revalidate=300']);
        $this->assertSame(self::LOADER_CODE, $response->getContent());
        $this->assertStringNotContainsString('__PNE_CHAT_BOOT__', $response->getContent());

        $this->useLoader('/nonexistent/loader.js');
        $this->assertStringContainsString('console.warn', $this->get('/widget/v1/loader.js')->assertOk()->getContent());
    }

    public function test_the_embed_page_is_a_cookie_free_shell_framable_by_the_widget_domains_only(): void
    {
        $response = $this->get('/embed/'.$this->widget->public_key);

        $response->assertOk()
            ->assertHeader('Content-Security-Policy', 'frame-ancestors *.shop.test customer.test')
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        $this->assertNull($response->headers->get('X-Frame-Options'));
        $this->assertSame([], $response->headers->getCookies());
        $this->assertNull($response->headers->get('Set-Cookie'));

        $response->assertSee('<div id="chat-root"></div>', false)->assertSee('window.__PNE_EMBED__', false);
        $embed = json_decode($this->embedJson($response), true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame([
            'key' => $this->widget->public_key,
            'appOrigin' => app(AppOrigin::class)->url(),
            'allowedHosts' => ['*.shop.test', 'customer.test'],
            'preview' => false,
            'mode' => 'launcher',
        ], $embed);
    }

    public function test_the_embed_page_modes_and_language(): void
    {
        $this->assertStringContainsString('"mode":"inline"', $this->embedJson($this->get('/embed/'.$this->widget->public_key.'?mode=inline')));
        $this->assertStringContainsString('"mode":"launcher"', $this->embedJson($this->get('/embed/'.$this->widget->public_key.'?mode=bogus')));

        $this->widget->forceFill(['locale' => 'ar'])->save();
        $this->get('/embed/'.$this->widget->public_key)->assertSee('lang="ar" dir="rtl"', false);
    }

    private function embedJson(TestResponse $response): string
    {
        $this->assertSame(1, preg_match('/window\.__PNE_EMBED__ = JSON\.parse\(\'(.*)\'\);/', $response->getContent(), $matches));

        // Js::from() emits a JavaScript string literal (\u0022, \/ ...): the JSON text is what the literal evaluates to.
        return (string) json_decode('"'.$matches[1].'"');
    }

    public function test_a_widget_without_domains_cannot_be_framed_at_all(): void
    {
        $widget = Widget::factory()->enabled()->create();

        $this->get('/embed/'.$widget->public_key)->assertOk()->assertHeader('Content-Security-Policy', "frame-ancestors 'none'");
    }

    public function test_the_embed_page_404s_for_unknown_disabled_and_deleted_widgets(): void
    {
        $this->get('/embed/wk_doesnotexist0000000000')->assertNotFound();
        $this->get('/embed/garbage')->assertNotFound();

        $this->widget->forceFill(['is_enabled' => false])->save();
        $this->get('/embed/'.$this->widget->public_key)->assertNotFound();
        $this->get('/c/'.$this->widget->public_key)->assertNotFound();

        $this->widget->forceFill(['is_enabled' => true])->save();
        $this->widget->delete();
        $this->get('/embed/'.$this->widget->public_key)->assertNotFound();
    }

    public function test_the_hosted_page_cannot_be_framed(): void
    {
        $response = $this->get('/c/'.$this->widget->public_key);

        $response->assertOk()
            ->assertHeader('Content-Security-Policy', "frame-ancestors 'none'")
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertSee('<div id="chat-root"></div>', false);
        $this->assertSame([], $response->headers->getCookies());
        $this->assertStringContainsString('"mode":"hosted"', $this->embedJson($response));
        $this->assertStringContainsString('"allowedHosts":[]', $this->embedJson($response));
    }

    public function test_the_preview_is_for_signed_in_administrators_only(): void
    {
        $url = '/embed/'.$this->widget->public_key.'?preview=1';

        $this->get($url)->assertForbidden();

        $agent = User::factory()->agent()->create();
        $this->get($url, $this->sessionCookieFor($agent))->assertForbidden();
    }

    public function test_the_admin_preview_is_framable_by_the_dashboard_only_and_sets_no_cookie(): void
    {
        $this->widget->forceFill(['is_enabled' => false])->save();
        $admin = User::factory()->admin()->create();

        $response = $this->get('/embed/'.$this->widget->public_key.'?preview=1&mode=inline', $this->sessionCookieFor($admin));

        $response->assertOk()
            ->assertHeader('Content-Security-Policy', "frame-ancestors 'self'")
            ->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->assertStringContainsString('private', (string) $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertSame([], $response->headers->getCookies(), 'the session cookie is read, never written');
        $this->assertStringContainsString('"preview":true', $this->embedJson($response));

        // The same widget is not served to anybody else while it is disabled.
        $this->get('/embed/'.$this->widget->public_key)->assertNotFound();
    }

    public function test_a_session_cookie_alone_does_not_turn_the_flag_on(): void
    {
        $admin = User::factory()->admin()->create();

        $response = $this->get('/embed/'.$this->widget->public_key, $this->sessionCookieFor($admin));

        $response->assertOk()->assertHeader('Content-Security-Policy', 'frame-ancestors *.shop.test customer.test');
        $this->assertStringContainsString('"preview":false', $this->embedJson($response));
        $this->assertSame([], $response->headers->getCookies());
    }

    /**
     * Sign in through the real login route and return the session cookie as a request header set.
     *
     * @return array<string, string>
     */
    private function sessionCookieFor(User $user): array
    {
        $login = $this->post('/login', ['email' => $user->email, 'password' => 'password']);
        $cookie = $login->getCookie((string) config('session.cookie'), false);

        $this->assertNotNull($cookie, 'the login did not start a session');
        $this->flushSession();
        $this->defaultCookies = [];
        $this->unencryptedCookies = [];
        $this->withUnencryptedCookie((string) config('session.cookie'), (string) $cookie->getValue());

        return [];
    }

    public function test_the_script_is_not_served_to_a_website_that_is_not_on_the_domain_list(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.example'])->create();
        $url = '/w/'.$widget->public_key.'.js';

        $listed = $this->withHeaders(['Referer' => 'https://customer.example/pricing'])->get($url);
        $listed->assertOk();
        $this->assertStringContainsString('__PNE_CHAT_BOOT__', $listed->getContent());
        $this->assertStringContainsString('Referer', (string) $listed->headers->get('Vary'));

        $blocked = $this->withHeaders(['Referer' => 'https://evil.example/copy-of-our-site'])->get($url);
        $blocked->assertStatus(403);
        $this->assertStringNotContainsString('__PNE_CHAT_BOOT__', $blocked->getContent());
        $this->assertStringNotContainsString($widget->public_key, $blocked->getContent());
        $this->assertStringContainsString('no-store', (string) $blocked->headers->get('Cache-Control'));

        // Look-alikes and userinfo tricks are not the listed site.
        $this->withHeaders(['Referer' => 'https://customer.example.evil.net/'])->get($url)->assertStatus(403);
        $this->withHeaders(['Referer' => 'https://customer.example@evil.example/'])->get($url)->assertOk();

        // No Referer (privacy settings): it cannot be judged, so it is served like before.
        $this->get($url)->assertOk();
    }
}
