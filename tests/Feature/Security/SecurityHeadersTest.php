<?php

namespace Tests\Feature\Security;

use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\User;
use App\Models\Visitor;
use App\Models\WaChat;
use App\Models\Widget;
use DOMDocument;
use DOMXPath;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Vite;
use Illuminate\Testing\TestResponse;
use Tests\Support\ChatFixtures;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * The browser-facing hardening of the dashboard: the Content-Security-Policy (per-request nonce, same-origin assets, Reverb and the
 * application origin in `connect-src`), its three modes, and the other security headers. The page crawl is the proof that every page
 * type's HTML works under the policy WITHOUT a browser: every inline script carries the nonce, no inline event handler or `javascript:`
 * URL exists, and visitor-controlled text that reaches the page props cannot break out of the JSON data block.
 *
 * What a browser does with the policy is the e2e checklist in docs/testing.md ("CSP verification checklist").
 */
class SecurityHeadersTest extends TestCase
{
    use ChatFixtures, InteractsWithRealtime, RefreshDatabase;

    private const HOSTILE = '</script><script>alert(1)</script><img src=x onerror=alert(2)>';

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        config(['chat.security.csp_mode' => 'enforce', 'chat.security.csp_report_uri' => '/csp-report']);
        $this->fakeViteBuild();
    }

    protected function tearDown(): void
    {
        File::deleteDirectory(storage_path('framework/testing/vite-csp'));

        parent::tearDown();
    }

    /** A manifest with an entry for every page component, so `@vite` prints the tags the production build would. */
    private function fakeViteBuild(): void
    {
        $dir = storage_path('framework/testing/vite-csp');
        File::ensureDirectoryExists($dir.'/assets');

        $manifest = [
            'resources/css/app.css' => ['file' => 'assets/app-abc123.css', 'src' => 'resources/css/app.css', 'isEntry' => true],
            'resources/js/embed/main.tsx' => ['file' => 'assets/embed-abc123.js', 'src' => 'resources/js/embed/main.tsx', 'isEntry' => true],
            'resources/js/app.tsx' => ['file' => 'assets/app-abc123.js', 'src' => 'resources/js/app.tsx', 'isEntry' => true, 'css' => ['assets/app-abc123.css'], 'imports' => ['_shared.js']],
            '_shared.js' => ['file' => 'assets/shared-abc123.js'],
        ];

        foreach (File::allFiles(resource_path('js/pages')) as $file) {
            $name = 'resources/js/pages/'.str_replace('\\', '/', $file->getRelativePathname());
            $manifest[$name] = ['file' => 'assets/'.md5($name).'.js', 'src' => $name, 'isEntry' => true, 'imports' => ['_shared.js']];
        }

        File::put($dir.'/manifest.json', json_encode($manifest));
        Vite::useBuildDirectory('../storage/framework/testing/vite-csp');
    }

    // ---- helpers ------------------------------------------------------------------------------------------------------------

    /** @return array<string, string> directive => value */
    private function directives(TestResponse $response, string $header = 'Content-Security-Policy'): array
    {
        $directives = [];

        foreach (explode(';', (string) $response->headers->get($header)) as $part) {
            $part = trim($part);

            if ($part === '') {
                continue;
            }

            [$name, $value] = array_pad(explode(' ', $part, 2), 2, '');
            $directives[$name] = $value;
        }

        return $directives;
    }

    private function nonceOf(TestResponse $response): string
    {
        $this->assertSame(1, preg_match("/'nonce-([A-Za-z0-9]{32,})'/", $this->directives($response)['script-src'] ?? '', $matches), 'script-src carries a nonce');

        return $matches[1];
    }

    private function dom(TestResponse $response): DOMDocument
    {
        $dom = new DOMDocument;
        libxml_use_internal_errors(true);
        $dom->loadHTML((string) $response->getContent());
        libxml_clear_errors();

        return $dom;
    }

    /** Every inline script has the nonce, nothing executes without one (no handler attributes, no javascript: URLs, no embeds). */
    private function assertWorksUnderThePolicy(TestResponse $response, string $page): void
    {
        $nonce = $this->nonceOf($response);
        $dom = $this->dom($response);
        $xpath = new DOMXPath($dom);
        $inline = 0;

        foreach ($dom->getElementsByTagName('script') as $script) {
            $type = strtolower($script->getAttribute('type'));

            if ($script->hasAttribute('src')) {
                $this->assertSameOrigin($script->getAttribute('src'), "{$page}: script src");
                $this->assertSame($nonce, $script->getAttribute('nonce'), "{$page}: a script tag Vite prints must carry the nonce");

                continue;
            }

            if (in_array($type, ['application/json', 'application/ld+json'], true)) {
                continue;
            }

            $inline++;
            $this->assertSame($nonce, $script->getAttribute('nonce'), "{$page}: an inline script without the nonce would be blocked");
        }

        $this->assertSame(1, $inline, "{$page}: exactly one inline script (the appearance probe) is expected");
        $this->assertSame(0, $xpath->query('//@*[starts-with(translate(name(), "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "on")]')->length, "{$page}: inline event handler attribute");
        $this->assertSame(0, $xpath->query('//*[contains(translate(@href, "JAVASCRIPT", "javascript"), "javascript:") or contains(translate(@src, "JAVASCRIPT", "javascript"), "javascript:") or contains(translate(@action, "JAVASCRIPT", "javascript"), "javascript:")]')->length, "{$page}: javascript: URL");
        $this->assertSame(0, $xpath->query('//iframe[@srcdoc] | //object | //embed | //base | //meta[translate(@http-equiv, "REFRSH", "refrsh")="refresh"]')->length, "{$page}: srcdoc / object / embed / base / meta refresh");

        foreach ($xpath->query('//link[@href]') as $link) {
            $this->assertSameOrigin($link->getAttribute('href'), "{$page}: link href");
        }

        // The hostile text reached the page as DATA (inside the JSON block), never as markup.
        $this->assertSame(0, $xpath->query('//img[@src="x"]')->length, "{$page}: injected <img>");
        $this->assertStringNotContainsString('<script>alert(1)</script>', (string) $response->getContent(), "{$page}: raw script injection");
    }

    private function assertSameOrigin(string $url, string $what): void
    {
        $host = parse_url($url, PHP_URL_HOST);

        $this->assertTrue($host === null || $host === parse_url((string) config('app.url'), PHP_URL_HOST) || $host === 'localhost', "{$what} {$url} must be same-origin");
    }

    // ---- the policy -------------------------------------------------------------------------------------------------------------

    public function test_the_page_exposes_its_own_nonce_in_a_meta_tag_for_the_builder_preview(): void
    {
        // The builder preview builds an `srcdoc` document in the browser; it inherits this policy, so its inline scripts need this nonce.
        $response = $this->get('/login');

        $this->assertSame(1, preg_match('/<meta name="csp-nonce" content="([A-Za-z0-9]+)"/', (string) $response->getContent(), $matches));
        $this->assertSame($this->nonceOf($response), $matches[1]);
    }

    public function test_a_dashboard_page_carries_a_strict_policy_with_a_fresh_nonce_per_request(): void
    {
        $first = $this->get('/login');
        $second = $this->get('/login');

        $directives = $this->directives($first);

        $this->assertNotSame($this->nonceOf($first), $this->nonceOf($second), 'one nonce per request');
        $this->assertSame("'self'", $directives['default-src']);
        $this->assertSame("'self' 'nonce-".$this->nonceOf($first)."'", $directives['script-src']);
        $this->assertSame("'self' 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net", $directives['style-src'], 'only the hosts a widget font may come from, for the builder preview');
        $this->assertSame("'none'", $directives['object-src']);
        $this->assertSame("'self'", $directives['base-uri']);
        $this->assertSame("'self'", $directives['form-action']);
        $this->assertSame("'self'", $directives['frame-ancestors']);
        $this->assertSame("'self'", $directives['worker-src']);
        $this->assertSame("'self'", $directives['manifest-src']);
        $this->assertSame("'self'", $directives['frame-src']);
        $this->assertSame("'self' data: blob: https:", $directives['img-src']);
        $this->assertSame("'self' data: https://fonts.gstatic.com https://fonts.bunny.net", $directives['font-src']);
        $this->assertSame("'self' data: blob:", $directives['media-src']);
        $this->assertSame('/csp-report', $directives['report-uri']);
        $this->assertStringNotContainsString("'unsafe-eval'", (string) $first->headers->get('Content-Security-Policy'));
        $this->assertStringNotContainsString("'strict-dynamic'", (string) $first->headers->get('Content-Security-Policy'));
        $this->assertStringNotContainsString("script-src 'self' 'unsafe-inline'", (string) $first->headers->get('Content-Security-Policy'));
        $this->assertArrayNotHasKey('upgrade-insecure-requests', $directives, 'only behind https');
    }

    public function test_upgrade_insecure_requests_is_added_only_on_https(): void
    {
        $response = $this->withServerVariables(['HTTPS' => 'on'])->get('https://localhost/login');

        $this->assertArrayHasKey('upgrade-insecure-requests', $this->directives($response));
    }

    public function test_connect_src_allows_the_reverb_websocket_and_a_differing_application_origin(): void
    {
        $this->useReverbBroadcaster();
        config(['reverb.apps.apps.0.options.host' => 'chat.example.test', 'reverb.apps.apps.0.options.port' => 443, 'reverb.apps.apps.0.options.scheme' => 'https']);
        settings()->set('app.url', 'https://app.example.test');
        $this->app->forgetInstance(ReverbEndpoint::class);

        $directives = $this->directives($this->get('/login'));

        $this->assertSame("'self' https://app.example.test https://fonts.googleapis.com https://fonts.bunny.net wss://chat.example.test", $directives['connect-src']);
        $this->assertStringContainsString('https://app.example.test', $directives['img-src']);
    }

    public function test_a_reverb_on_a_custom_port_over_plain_http_is_allowed_as_ws(): void
    {
        $this->useReverbBroadcaster();
        config(['reverb.apps.apps.0.options.host' => 'localhost', 'reverb.apps.apps.0.options.port' => 8316, 'reverb.apps.apps.0.options.scheme' => 'http']);

        $this->assertStringContainsString('ws://localhost:8316', $this->directives($this->get('/login'))['connect-src']);
    }

    public function test_without_realtime_nothing_is_added_for_websockets(): void
    {
        config(['broadcasting.default' => 'null']);

        $this->assertSame("'self' https://fonts.googleapis.com https://fonts.bunny.net", $this->directives($this->get('/login'))['connect-src'], 'only the widget font hosts (the builder preview fetches the stylesheet)');
    }

    public function test_a_host_that_could_smuggle_a_directive_is_dropped(): void
    {
        $this->useReverbBroadcaster();
        config(['reverb.apps.apps.0.options.host' => 'evil.test; script-src *']);

        $policy = (string) $this->get('/login')->headers->get('Content-Security-Policy');

        $this->assertStringNotContainsString('evil.test', $policy);
        $this->assertStringNotContainsString('script-src *', $policy);
    }

    public function test_the_vite_dev_server_is_allowed_only_while_it_runs(): void
    {
        $hot = public_path('hot');
        $existed = File::exists($hot);
        $before = $existed ? File::get($hot) : null;

        try {
            File::put($hot, 'http://[::1]:5173');
            $directives = $this->directives($this->get('/login'));

            $this->assertStringContainsString('http://[::1]:5173', $directives['script-src']);
            $this->assertStringContainsString('ws://[::1]:5173', $directives['connect-src']);
        } finally {
            $existed ? File::put($hot, (string) $before) : File::delete($hot);
        }

        $this->assertStringNotContainsString('5173', (string) $this->get('/login')->headers->get('Content-Security-Policy'));
    }

    // ---- modes ----------------------------------------------------------------------------------------------------------------

    public function test_report_only_mode_blocks_nothing_but_keeps_the_framing_policy_enforced(): void
    {
        config(['chat.security.csp_mode' => 'report-only']);

        $response = $this->get('/login');

        $this->assertSame("frame-ancestors 'self'", $response->headers->get('Content-Security-Policy'));
        $this->assertStringContainsString("script-src 'self' 'nonce-", (string) $response->headers->get('Content-Security-Policy-Report-Only'));
        $response->assertHeader('X-Frame-Options', 'SAMEORIGIN');
    }

    public function test_off_mode_keeps_the_framing_policy_only(): void
    {
        config(['chat.security.csp_mode' => 'off']);

        $response = $this->get('/login');

        $this->assertSame("frame-ancestors 'self'", $response->headers->get('Content-Security-Policy'));
        $this->assertNull($response->headers->get('Content-Security-Policy-Report-Only'));
    }

    public function test_the_default_mode_is_enforce_in_production_and_report_only_elsewhere(): void
    {
        $config = require base_path('config/chat.php');

        $this->assertContains($config['security']['csp_mode'], ['enforce', 'report-only']);
        $this->assertSame('report-only', env('CSP_MODE') ?: ($this->app->environment('production') ? 'enforce' : 'report-only'), 'the testing environment is not production');
    }

    public function test_an_empty_report_uri_switches_reporting_off(): void
    {
        config(['chat.security.csp_report_uri' => '']);

        $this->assertArrayNotHasKey('report-uri', $this->directives($this->get('/login')));
    }

    public function test_a_report_uri_that_leaves_the_origin_or_the_header_is_ignored(): void
    {
        foreach (['https://collector.example/x', '//collector.example/x', '/x; script-src *', '/x,y'] as $uri) {
            config(['chat.security.csp_report_uri' => $uri]);

            $this->assertArrayNotHasKey('report-uri', $this->directives($this->get('/login')), $uri);
        }
    }

    // ---- other headers ----------------------------------------------------------------------------------------------------------

    public function test_the_other_security_headers_of_a_dashboard_page(): void
    {
        $response = $this->get('/login');

        $response->assertHeader('X-Content-Type-Options', 'nosniff');
        $response->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        $response->assertHeader('Cross-Origin-Opener-Policy', 'same-origin');
        $response->assertHeader('X-Permitted-Cross-Domain-Policies', 'none');
        $response->assertHeader('X-Frame-Options', 'SAMEORIGIN');
        $permissions = (string) $response->headers->get('Permissions-Policy');

        foreach (['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()'] as $denied) {
            $this->assertStringContainsString($denied, $permissions);
        }

        // Features the dashboard uses stay at their default allow-list: passkeys, notification sounds, fullscreen.
        foreach (['publickey-credentials', 'autoplay', 'fullscreen', 'clipboard'] as $needed) {
            $this->assertStringNotContainsString($needed, $permissions);
        }
    }

    public function test_hsts_is_sent_only_over_https_and_can_be_tuned_or_switched_off(): void
    {
        $this->get('/login')->assertHeaderMissing('Strict-Transport-Security');

        $secure = fn () => $this->withServerVariables(['HTTPS' => 'on'])->get('https://localhost/login');

        $this->assertSame('max-age=31536000', $secure()->headers->get('Strict-Transport-Security'));

        config(['chat.security.hsts_max_age' => 600, 'chat.security.hsts_include_subdomains' => true]);
        $this->assertSame('max-age=600; includeSubDomains', $secure()->headers->get('Strict-Transport-Security'));

        config(['chat.security.hsts_max_age' => 0]);
        $secure()->assertHeaderMissing('Strict-Transport-Security');
    }

    public function test_api_and_public_responses_get_the_machine_facing_headers(): void
    {
        $management = $this->actingAs(User::factory()->admin()->create(), 'sanctum')->getJson('/api/v1/conversations');
        $management->assertOk()->assertHeader('X-Content-Type-Options', 'nosniff')->assertHeader('Referrer-Policy', 'no-referrer');

        $this->postJson('/api/v1/public/broadcasting/auth')->assertHeader('X-Content-Type-Options', 'nosniff')->assertHeader('Referrer-Policy', 'no-referrer');
        $this->withServerVariables(['HTTPS' => 'on'])->getJson('https://localhost/api/v1/public/widgets/wk_doesnotexist0000000/config')->assertHeader('Strict-Transport-Security');
    }

    // ---- what must not change ---------------------------------------------------------------------------------------------------

    public function test_the_embeddable_pages_and_the_loader_keep_their_own_policies(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.example'])->create();

        $embed = $this->get('/embed/'.$widget->public_key);
        $embed->assertOk();
        $this->assertSame('frame-ancestors customer.example', $embed->headers->get('Content-Security-Policy'));
        $this->assertNull($embed->headers->get('X-Frame-Options'));
        $this->assertNull($embed->headers->get('Cross-Origin-Opener-Policy'), 'the embedded panel must not get the dashboard hardening');

        $this->get('/c/'.$widget->public_key)->assertOk();
        $this->get('/w/'.$widget->public_key.'.js', ['Referer' => 'https://customer.example/'])->assertOk()->assertHeaderMissing('Content-Security-Policy');
    }

    public function test_pages_under_docs_keep_the_framing_policy_only(): void
    {
        // The generated API documentation brings inline scripts of its own: it is not ours to nonce.
        Route::middleware('web')->get('/docs/_probe', fn () => response('<!doctype html><script>var x = 1;</script>'));

        $response = $this->get('/docs/_probe');

        $response->assertOk();
        $this->assertSame("frame-ancestors 'self'", $response->headers->get('Content-Security-Policy'));
        $this->assertNull($response->headers->get('Content-Security-Policy-Report-Only'));
        $response->assertHeader('Cross-Origin-Opener-Policy', 'same-origin');
    }

    public function test_the_install_pages_are_covered_too(): void
    {
        InstallStateFake::make(installed: false);

        $response = $this->get('/setup');

        $this->assertWorksUnderThePolicy($response, 'setup');
    }

    // ---- every page type works under the policy ---------------------------------------------------------------------------------

    /**
     * @return array<string, string> label => path of every dashboard page type, with visitor-controlled and admin-typed text in its data
     */
    private function dashboardPages(): array
    {
        $category = Category::factory()->create(['slug' => 'billing', 'name' => self::HOSTILE]);
        $widget = Widget::factory()->enabled()->withDomains(['customer.test'])->create(['name' => self::HOSTILE]);
        $widget->categories()->attach($category->id, ['sort_order' => 0]);
        $agent = User::factory()->agent()->create(['name' => self::HOSTILE]);
        $visitor = Visitor::factory()->create(['widget_id' => $widget->id, 'name' => self::HOSTILE, 'email' => 'x@example.test']);
        $conversation = Conversation::factory()->forCategory($category)->active($agent)->create(['visitor_id' => $visitor->id, 'widget_id' => $widget->id, 'last_message_preview' => self::HOSTILE]);
        Message::factory()->for($conversation)->create(['body' => self::HOSTILE]);
        $chat = WaChat::factory()->create(['push_name' => self::HOSTILE, 'last_message_preview' => self::HOSTILE]);

        return [
            'dashboard' => '/dashboard',
            'inbox' => '/inbox',
            'conversation' => '/inbox/'.$conversation->ulid,
            'history' => '/history',
            'analytics' => '/analytics',
            'offline tickets' => '/offline-tickets',
            'agents' => '/agents',
            'categories' => '/categories',
            'widgets' => '/widgets',
            'widget builder' => '/widgets/'.$widget->ulid,
            'whatsapp inbox' => '/whatsapp',
            'whatsapp chat' => '/whatsapp/chats/'.$chat->ulid,
            'profile' => '/settings/profile',
            'security' => '/settings/security',
            'support categories' => '/settings/support-categories',
            'whatsapp settings' => '/settings/whatsapp',
        ];
    }

    public function test_every_dashboard_page_type_carries_the_nonce_on_its_inline_script_and_has_no_inline_handler(): void
    {
        $admin = User::factory()->admin()->create(['name' => self::HOSTILE]);
        $pages = $this->dashboardPages();

        $this->assertGreaterThanOrEqual(15, count($pages));

        foreach ($pages as $label => $path) {
            // The security settings ask for a recent password confirmation.
            $response = $this->actingAs($admin)->withSession(['auth.password_confirmed_at' => time()])->get($path);

            $this->assertSame(200, $response->getStatusCode(), $label.' answered '.$response->getStatusCode().' '.$response->headers->get('Location'));
            $this->assertStringContainsString('text/html', (string) $response->headers->get('Content-Type'), $label);
            $this->assertWorksUnderThePolicy($response, $label);
        }
    }

    public function test_the_guest_pages_work_under_the_policy_too(): void
    {
        foreach (['login' => '/login', 'forgot password' => '/forgot-password', 'reset password' => '/reset-password/abc?email=a@b.test'] as $label => $path) {
            $response = $this->get($path);

            $response->assertOk();
            $this->assertWorksUnderThePolicy($response, $label);
        }
    }

    public function test_error_pages_and_the_unavailable_page_carry_the_policy_and_no_script(): void
    {
        // A bound model that does not exist: the exception comes from an inner middleware, the headers still reach the page.
        $missing = $this->actingAs(User::factory()->admin()->create())->get('/inbox/'.str_repeat('0', 26));

        $this->assertSame(404, $missing->getStatusCode());
        $this->assertStringContainsString("object-src 'none'", (string) $missing->headers->get('Content-Security-Policy'));
        $missing->assertHeader('X-Frame-Options', 'SAMEORIGIN');
        $this->assertStringNotContainsString('<script', (string) $missing->getContent());
    }
}
