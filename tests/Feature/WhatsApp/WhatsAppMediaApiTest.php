<?php

namespace Tests\Feature\WhatsApp;

use App\Domain\WhatsApp\Contracts\WaMediaUrls;
use App\Domain\WhatsApp\Support\SignedWaMediaUrls;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\WhatsAppSession;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\Images;
use Tests\Support\WhatsAppFixtures;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * `GET /whatsapp/media/{message}`: a stored image behind two credentials (the signature of the URL and an administrator's session), served
 * as an inert, sandboxed image with a neutral file name.
 */
class WhatsAppMediaApiTest extends TestCase
{
    use RefreshDatabase, WhatsAppFixtures, WidgetFixtures;

    private WaMessage $message;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        Storage::fake('local');
        $this->app->instance(WaMediaUrls::class, $this->app->make(SignedWaMediaUrls::class));

        $chat = WaChat::factory()->for(WhatsAppSession::factory()->ready(), 'session')->create();
        $bytes = Images::jpeg(20, 10);
        Storage::disk('local')->put('whatsapp/media/2026/10/abc.jpg', $bytes);
        $this->message = WaMessage::factory()->for($chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/abc.jpg', 'media_mime' => 'image/jpeg', 'media_filename' => '<script>evil.jpg']);
    }

    private function url(?WaMessage $message = null): string
    {
        return app(WaMediaUrls::class)->url($message ?? $this->message);
    }

    public function test_an_administrator_with_a_valid_signed_url_gets_the_image_with_inert_headers(): void
    {
        $admin = $this->whatsAppPeople()['admin'];

        $response = $this->actingAs($admin, 'sanctum')->get($this->url());

        $response->assertOk()
            ->assertHeader('Content-Type', 'image/jpeg')
            ->assertHeader('X-Content-Type-Options', 'nosniff')
            ->assertHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        $this->assertStringContainsString('inline; filename=image.jpg', (string) $response->headers->get('Content-Disposition'));
        $this->assertStringNotContainsString('evil', (string) $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('private', (string) $response->headers->get('Cache-Control'));
        $this->assertSame(Storage::disk('local')->get('whatsapp/media/2026/10/abc.jpg'), $response->streamedContent());
    }

    public function test_the_url_is_built_on_the_configured_app_origin_with_a_one_hour_signature(): void
    {
        $url = $this->url();

        $this->assertStringStartsWith(rtrim((string) config('app.url'), '/').'/api/v1/whatsapp/media/'.$this->message->ulid.'?', $url);
        parse_str((string) parse_url($url, PHP_URL_QUERY), $query);
        $this->assertEqualsWithDelta(now()->addMinutes(60)->getTimestamp(), (int) $query['expires'], 5);
        $this->assertArrayHasKey('signature', $query);
    }

    public function test_an_unsigned_altered_or_expired_url_is_refused_even_for_an_administrator(): void
    {
        $admin = $this->whatsAppPeople()['admin'];
        $plain = '/api/v1/whatsapp/media/'.$this->message->ulid;

        $this->actingAs($admin, 'sanctum')->get($plain)->assertForbidden();
        $this->actingAs($admin, 'sanctum')->get($this->url().'x')->assertForbidden();

        $other = WaMessage::factory()->for($this->message->chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/2026/10/abc.jpg']);
        $swapped = str_replace($this->message->ulid, $other->ulid, $this->url());
        $this->actingAs($admin, 'sanctum')->get($swapped)->assertForbidden();

        $this->travel(61)->minutes();
        $this->actingAs($admin, 'sanctum')->get($this->url())->assertOk();
        $url = $this->url();
        $this->travel(61)->minutes();
        $this->actingAs($admin, 'sanctum')->get($url)->assertForbidden();
    }

    public function test_a_valid_signature_alone_is_not_enough_everybody_else_is_turned_away(): void
    {
        $url = $this->url();
        $people = $this->whatsAppPeople();

        $this->get($url)->assertUnauthorized();
        $this->actingAs($people['agent'], 'sanctum')->get($url)->assertForbidden();
        // A browser's `<img>` request asks for no JSON: a user without a chat role (or a deactivated one) is signed out and redirected there.
        $this->actingAs($people['noRole'], 'sanctum')->getJson($url)->assertForbidden();
        $this->assertContains($this->actingAs($people['inactiveAdmin'], 'sanctum')->getJson($url)->getStatusCode(), [401, 403]);

        $this->actingAs($people['adminAndAgent'], 'sanctum')->get($url)->assertOk();
    }

    public function test_a_message_without_a_stored_file_or_with_a_missing_one_is_404(): void
    {
        $admin = $this->whatsAppPeople()['admin'];
        $typed = WaMessage::factory()->for($this->message->chat, 'chat')->inbound()->document()->create();
        $lost = WaMessage::factory()->for($this->message->chat, 'chat')->inbound()->image()->create(['media_path' => 'whatsapp/media/gone.jpg']);

        $this->actingAs($admin, 'sanctum')->get($this->url($typed))->assertNotFound();
        $this->actingAs($admin, 'sanctum')->get($this->url($lost))->assertNotFound();
    }

    public function test_the_stored_path_never_appears_in_any_payload(): void
    {
        $admin = $this->whatsAppPeople()['admin'];

        $body = $this->actingAs($admin, 'sanctum')->getJson('/api/v1/whatsapp/chats/'.$this->message->chat->ulid.'/messages')->assertOk()->getContent();

        $this->assertStringNotContainsString('whatsapp/media/2026', str_replace('\\/', '/', $body));
        $this->assertStringContainsString('/api/v1/whatsapp/media/'.$this->message->ulid, str_replace('\\/', '/', $body));
        $this->assertInstanceOf(User::class, $admin);
    }
}
