<?php

namespace Tests\Feature;

use App\Http\Middleware\TrustInstalledAppHost;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\Facades\Validator;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

class HardeningTest extends TestCase
{
    use RefreshDatabase;

    public function test_dashboard_and_auth_pages_can_only_be_framed_by_this_origin(): void
    {
        $response = $this->get('/login');

        $response->assertHeader('X-Frame-Options', 'SAMEORIGIN');
        $this->assertStringContainsString("frame-ancestors 'self'", (string) $response->headers->get('Content-Security-Policy'));
        $response->assertHeader('X-Content-Type-Options', 'nosniff');
        $response->assertHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }

    public function test_the_embeddable_page_keeps_its_own_framing_policy(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.example'])->create();

        $response = $this->get('/embed/'.$widget->public_key);

        $response->assertOk();
        $this->assertStringContainsString('customer.example', (string) $response->headers->get('Content-Security-Policy'));
        $this->assertNull($response->headers->get('X-Frame-Options'));
    }

    public function test_api_server_errors_use_the_documented_envelope_without_details(): void
    {
        config(['app.debug' => false]);
        Route::get('/api/v1/_boom', fn () => throw new \RuntimeException('secret internals'));

        $this->getJson('/api/v1/_boom')
            ->assertStatus(500)
            ->assertExactJson(['error' => ['code' => 'server_error', 'message' => 'Something went wrong on our side.']]);
    }

    public function test_secrets_typed_into_a_form_are_not_flashed_back_after_a_validation_error(): void
    {
        Route::middleware('web')->post('/_form', fn (Request $request) => $request->validate(['name' => 'required']));

        $this->from('/_form')->post('/_form', [
            'service_token' => 'super-secret-token',
            'environments' => ['production' => ['service_token' => 'nested-secret', 'nats_token' => 'nats-secret']],
        ])->assertSessionHasErrors('name');

        $old = (array) session()->get('_old_input', []);

        $this->assertArrayNotHasKey('service_token', $old);
        $this->assertArrayNotHasKey('service_token', (array) ($old['environments']['production'] ?? []));
        $this->assertArrayNotHasKey('nats_token', (array) ($old['environments']['production'] ?? []));
    }

    public function test_the_host_of_the_saved_app_url_is_a_stateful_sanctum_host(): void
    {
        settings()->set('app.url', 'https://chat.example.test:8443');

        app(TrustInstalledAppHost::class)->handle(Request::create('/api/v1/x'), fn () => new Response);

        $this->assertContains('chat.example.test:8443', (array) config('sanctum.stateful'));
    }

    public function test_legacy_and_canonical_timezone_ids_are_both_accepted(): void
    {
        foreach (['Asia/Calcutta', 'Asia/Kolkata', 'Europe/Kiev', 'Europe/Kyiv', 'America/Buenos_Aires', 'UTC'] as $zone) {
            $this->assertTrue(
                Validator::make(['timezone' => $zone], ['timezone' => ['timezone:all_with_bc']])->passes(),
                $zone.' should be accepted',
            );
        }
    }
}
