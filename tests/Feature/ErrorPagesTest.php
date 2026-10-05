<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Browser-facing errors are the app's own pages (a title, a sentence, a way back), not Laravel's bare "403 | message" line.
 */
class ErrorPagesTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    public function test_a_page_that_does_not_exist_says_so_and_leads_home(): void
    {
        $html = (string) $this->get('/no-such-page')->assertNotFound()->getContent();

        $this->assertStringContainsString('Page not found', $html);
        $this->assertStringContainsString('href="'.url('/').'"', $html);
        $this->assertStringContainsString('Go to the dashboard', $html);
        $this->assertStringNotContainsString('<script', $html, 'an error page must render without any script');
    }

    public function test_an_agent_on_an_admin_page_gets_the_reason_and_a_way_back(): void
    {
        $this->useFortifyMode();

        $html = (string) $this->actingAs(User::factory()->agent()->create())->get('/widgets')->assertForbidden()->getContent();

        $this->assertStringContainsString('You do not have access', $html);
        $this->assertStringContainsString('Only administrators can do this.', $html);
        $this->assertStringContainsString('Go to the dashboard', $html);
    }

    public function test_a_forbidden_page_without_a_message_does_not_show_the_framework_default(): void
    {
        Route::get('/_forbidden', fn () => abort(403));

        $html = (string) $this->get('/_forbidden')->assertForbidden()->getContent();

        $this->assertStringContainsString('Your account is not allowed to open this page.', $html);
        $this->assertStringNotContainsString('This action is unauthorized.', $html);
    }

    public function test_an_unavailable_application_shows_its_reason_and_offers_to_try_again(): void
    {
        Route::get('/_down', fn () => abort(503, 'Back at 10:00.'));

        $html = (string) $this->get('/_down')->assertStatus(503)->getContent();

        $this->assertStringContainsString('Back in a moment', $html);
        $this->assertStringContainsString('Back at 10:00.', $html);
        $this->assertStringContainsString('Try again', $html);
    }

    public function test_the_other_error_pages_render(): void
    {
        foreach ([419 => 'Your session expired', 429 => 'Too many requests', 500 => 'Something went wrong on our side'] as $status => $title) {
            Route::get('/_status/'.$status, fn () => abort($status));

            $this->get('/_status/'.$status)->assertStatus($status)->assertSee($title);
        }
    }

    public function test_the_api_keeps_answering_json(): void
    {
        $this->getJson('/api/v1/no-such-endpoint')->assertNotFound()->assertJsonStructure(['error' => ['code', 'message']]);
    }
}
