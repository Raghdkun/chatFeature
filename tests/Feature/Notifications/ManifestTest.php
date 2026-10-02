<?php

namespace Tests\Feature\Notifications;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `GET /manifest.webmanifest` (decision P5-D6) and the root view that links it. */
class ManifestTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_it_is_served_as_a_manifest_without_cookies_or_a_session(): void
    {
        $response = $this->get('/manifest.webmanifest')->assertOk();

        $this->assertStringStartsWith('application/manifest+json', (string) $response->headers->get('Content-Type'));
        $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));
        $this->assertStringContainsString('max-age=300', (string) $response->headers->get('Cache-Control'));
        $this->assertStringContainsString('public', (string) $response->headers->get('Cache-Control'));
        $this->assertSame([], $response->headers->getCookies());
        $this->assertFalse($response->headers->has('Set-Cookie'));
    }

    public function test_the_name_comes_from_the_settings(): void
    {
        settings()->set('app.name', 'Acme Support Desk');

        $this->getJson('/manifest.webmanifest')->assertOk()
            ->assertJsonPath('name', 'Acme Support Desk')
            ->assertJsonPath('short_name', 'Acme Support');

        settings()->set('app.name', 'Short');
        $this->getJson('/manifest.webmanifest')->assertJsonPath('short_name', 'Short');
    }

    public function test_it_describes_an_installable_app(): void
    {
        $manifest = $this->getJson('/manifest.webmanifest')->assertOk()->json();

        $this->assertSame('/', $manifest['id']);
        $this->assertSame('/', $manifest['scope']);
        $this->assertSame('/dashboard', $manifest['start_url']);
        $this->assertSame('standalone', $manifest['display']);
        $this->assertMatchesRegularExpression('/^#[0-9a-f]{6}$/', $manifest['theme_color']);
        $this->assertMatchesRegularExpression('/^#[0-9a-f]{6}$/', $manifest['background_color']);
        $this->assertSame('ltr', $manifest['dir']);
    }

    public function test_the_icons_exist_with_the_sizes_it_promises(): void
    {
        $icons = $this->getJson('/manifest.webmanifest')->json('icons');

        $this->assertContains('maskable', array_column($icons, 'purpose'));
        $this->assertContains('192x192', array_column($icons, 'sizes'));
        $this->assertContains('512x512', array_column($icons, 'sizes'));

        foreach ($icons as $icon) {
            $path = public_path(ltrim($icon['src'], '/'));
            $this->assertFileExists($path);
            $size = getimagesize($path);
            $this->assertSame('image/png', $size['mime']);
            $this->assertSame($icon['sizes'], $size[0].'x'.$size[1]);
        }

        // The notification badge and the iOS icon the root view points at.
        $this->assertSame([96, 96], array_slice(getimagesize(public_path('icons/badge-96.png')), 0, 2));
        $this->assertSame([180, 180], array_slice(getimagesize(public_path('apple-touch-icon.png')), 0, 2));
    }

    public function test_the_direction_follows_the_locale(): void
    {
        settings()->set('app.locale', 'ar');

        $this->getJson('/manifest.webmanifest')->assertJsonPath('lang', 'ar')->assertJsonPath('dir', 'rtl');
    }

    public function test_the_root_view_links_the_manifest_and_the_touch_icon(): void
    {
        $html = (string) $this->get('/login')->assertOk()->getContent();

        $this->assertStringContainsString('<link rel="manifest" href="/manifest.webmanifest">', $html);
        $this->assertStringContainsString('<link rel="apple-touch-icon" href="/apple-touch-icon.png">', $html);
    }

    public function test_the_service_worker_file_ships_in_public(): void
    {
        $this->assertFileExists(public_path('sw.js'));
    }
}
