<?php

namespace Tests\Feature\Chat;

use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Support\SignedAttachmentUrls;
use App\Models\Attachment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\URL;
use Illuminate\Validation\ValidationException;
use Tests\TestCase;

class AttachmentUrlsTest extends TestCase
{
    use RefreshDatabase;

    private function registerAttachmentRoute(): void
    {
        Route::middleware(['widget', 'signed'])
            ->get('/api/v1/public/attachments/{attachment}', fn (string $attachment): string => 'file '.$attachment)
            ->name(SignedAttachmentUrls::ROUTE);

        // Routes added after boot are not in the name lookup yet.
        Route::getRoutes()->refreshNameLookups();
    }

    public function test_the_signed_implementation_is_the_default_binding(): void
    {
        $this->assertInstanceOf(SignedAttachmentUrls::class, app(AttachmentUrls::class));
    }

    public function test_urls_are_signed_temporary_links_to_the_attachment_route(): void
    {
        $this->registerAttachmentRoute();
        $attachment = Attachment::factory()->create();
        $urls = app(AttachmentUrls::class);

        $url = $urls->url($attachment);
        $thumb = $urls->thumbUrl($attachment);

        $this->assertNotNull($thumb);
        $this->assertStringContainsString('/api/v1/public/attachments/'.$attachment->ulid, $url);
        $this->assertStringContainsString('expires=', $url);
        $this->assertStringContainsString('signature=', $url);
        $this->assertStringContainsString('thumb=1', $thumb);
        $this->assertNotSame($url, $thumb);
        $this->assertTrue(URL::hasValidSignature(Request::create($url)));
        $this->assertTrue(URL::hasValidSignature(Request::create($thumb)));
        $this->assertStringNotContainsString($attachment->path, $url);
    }

    public function test_the_urls_work_without_a_bearer_token_and_a_tampered_one_is_refused(): void
    {
        $this->registerAttachmentRoute();
        $attachment = Attachment::factory()->create();
        $url = app(AttachmentUrls::class)->url($attachment);

        $this->get($url)->assertOk()->assertSee('file '.$attachment->ulid);
        $this->get(str_replace($attachment->ulid, Attachment::factory()->create()->ulid, $url))->assertForbidden();
        $this->get($url.'&thumb=1')->assertForbidden();
    }

    public function test_the_thumbnail_link_cannot_be_turned_into_the_original(): void
    {
        $this->registerAttachmentRoute();
        $attachment = Attachment::factory()->create();
        $thumb = (string) app(AttachmentUrls::class)->thumbUrl($attachment);

        $this->get(str_replace('thumb=1&', '', $thumb))->assertForbidden();
        $this->get(str_replace('thumb=1', 'thumb=0', $thumb))->assertForbidden();
    }

    public function test_the_links_live_four_hours_by_default_and_the_lifetime_is_a_setting(): void
    {
        $this->registerAttachmentRoute();
        $this->travelTo('2026-11-20 10:00:00');
        $url = app(AttachmentUrls::class)->url(Attachment::factory()->create());

        $this->travelTo('2026-11-20 13:59:00');
        $this->get($url)->assertOk();

        $this->travelTo('2026-11-20 14:01:00');
        $this->get($url)->assertForbidden();

        settings()->set('chat.attachment_url_ttl_minutes', 30);
        $this->travelTo('2026-11-21 10:00:00');
        $short = app(AttachmentUrls::class)->url(Attachment::factory()->create());

        $this->travelTo('2026-11-21 10:29:00');
        $this->get($short)->assertOk();

        $this->travelTo('2026-11-21 10:31:00');
        $this->get($short)->assertForbidden();
    }

    public function test_the_lifetime_setting_has_bounds(): void
    {
        $this->assertSame(240, settings('chat.attachment_url_ttl_minutes'));

        foreach ([4, 1441, 'long'] as $invalid) {
            try {
                settings()->set('chat.attachment_url_ttl_minutes', $invalid);
                $this->fail('accepted '.json_encode($invalid));
            } catch (ValidationException) {
                $this->addToAssertionCount(1);
            }
        }
    }

    public function test_the_host_comes_from_the_configured_origin_never_from_the_request(): void
    {
        $this->registerAttachmentRoute();
        $attachment = Attachment::factory()->create();
        settings()->set('app.url', 'https://chat.example.com');

        // The request says the host is evil.test (a forged Host header the proxy let through).
        $this->app->instance('request', Request::create('http://evil.test/anything'));
        $url = app(AttachmentUrls::class)->url($attachment);
        $thumb = (string) app(AttachmentUrls::class)->thumbUrl($attachment);

        $this->assertStringStartsWith('https://chat.example.com/api/v1/public/attachments/'.$attachment->ulid.'?', $url);
        $this->assertStringStartsWith('https://chat.example.com/api/v1/public/attachments/'.$attachment->ulid.'?', $thumb);
        $this->assertStringNotContainsString('evil.test', $url.$thumb);

        // The signature belongs to the configured origin, so it is valid there ...
        $this->assertTrue(URL::hasValidSignature(Request::create($url)));
        // ... and the forced root does not leak into any other URL the application generates.
        $this->assertStringStartsWith('http://evil.test/', route(SignedAttachmentUrls::ROUTE, ['attachment' => $attachment->ulid]));
        $this->assertStringStartsWith('http://evil.test/', url('/anything'));
    }

    public function test_an_attachment_without_a_thumbnail_has_no_thumb_url(): void
    {
        $this->registerAttachmentRoute();
        $attachment = Attachment::factory()->create(['thumb_path' => null]);

        $this->assertNull(app(AttachmentUrls::class)->thumbUrl($attachment));
        $this->assertNotNull(app(AttachmentUrls::class)->url($attachment));
    }

    public function test_the_rest_track_registers_the_real_route_these_urls_point_at(): void
    {
        $attachment = Attachment::factory()->create();

        $route = Route::getRoutes()->getByName(SignedAttachmentUrls::ROUTE);

        $this->assertNotNull($route);
        $this->assertSame('api/v1/public/attachments/{attachment}', $route->uri());
        $this->assertContains('signed', $route->gatherMiddleware());
        $this->assertStringContainsString('/api/v1/public/attachments/'.$attachment->ulid, app(AttachmentUrls::class)->url($attachment));
    }
}
