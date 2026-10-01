<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class AdminMiddlewareTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'admin'])->get('/api/v1/_admin-probe', fn () => ['ok' => true]);
    }

    public function test_admins_pass(): void
    {
        $this->actingAs(User::factory()->admin()->create(), 'sanctum')->getJson('/api/v1/_admin-probe')->assertOk();
    }

    public function test_agents_are_forbidden_with_a_json_error(): void
    {
        $this->actingAs(User::factory()->agent()->create(), 'sanctum')
            ->getJson('/api/v1/_admin-probe')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'forbidden');
    }

    public function test_guests_are_unauthenticated(): void
    {
        $this->getJson('/api/v1/_admin-probe')->assertUnauthorized();
    }

    public function test_the_dashboard_session_cookie_authenticates_the_management_api(): void
    {
        // statefulApi(): same-origin SPA requests carry the session, not a bearer token.
        $admin = User::factory()->admin()->create();

        $this->withHeaders(['Referer' => config('app.url'), 'Origin' => config('app.url')])
            ->actingAs($admin)
            ->getJson('/api/v1/_admin-probe')
            ->assertOk();
    }
}
