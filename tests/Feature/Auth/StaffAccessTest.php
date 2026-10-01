<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\TestCase;

class StaffAccessTest extends TestCase
{
    use RefreshDatabase;

    public function test_staff_without_a_verified_email_can_reach_the_dashboard(): void
    {
        $agent = User::factory()->agent()->unverified()->create();

        $this->actingAs($agent)->get(route('dashboard'))->assertOk();
    }

    public function test_api_tokens_are_scoped_to_staff_and_expire(): void
    {
        $agent = User::factory()->agent()->create(['password' => 'correct-horse-battery']);

        $result = app(AuthDriver::class)->attemptForApi(['email' => $agent->email, 'password' => 'correct-horse-battery'], 'phone');

        $this->assertTrue($result->isOk());
        $token = PersonalAccessToken::findToken((string) $result->token);

        $this->assertNotNull($token);
        $this->assertSame(['staff'], $token->abilities);
        $this->assertGreaterThan(0, (int) config('sanctum.expiration'));
    }

    public function test_deactivating_a_user_revokes_their_api_tokens(): void
    {
        $agent = User::factory()->agent()->create();
        $agent->createToken('phone', ['staff']);

        $agent->update(['is_active' => true]);
        $this->assertSame(1, $agent->tokens()->count());

        $agent->forceFill(['is_active' => false])->save();

        $this->assertSame(0, $agent->tokens()->count());
    }

    public function test_losing_every_chat_role_revokes_api_tokens(): void
    {
        $agent = User::factory()->agent()->create();
        $agent->createToken('phone', ['staff']);

        $agent->forceFill(['is_agent' => false])->save();

        $this->assertSame(0, $agent->tokens()->count());
    }

    public function test_the_session_valid_alias_turns_away_deactivated_users_even_with_a_token(): void
    {
        Route::middleware(['auth:sanctum', 'session.valid', 'chat.access'])->get('/api/v1/_probe', fn () => ['ok' => true]);

        $agent = User::factory()->agent()->create();
        $plain = $agent->createToken('phone', ['staff'])->plainTextToken;

        $this->withToken($plain)->getJson('/api/v1/_probe')->assertOk();

        // Deactivate WITHOUT model events, so the token survives and only the middleware can stop the request.
        $agent->forceFill(['is_active' => false])->saveQuietly();
        // Guards cache the resolved user between requests of one test; a real request starts clean.
        $this->app['auth']->forgetGuards();

        $this->withToken($plain)->getJson('/api/v1/_probe')
            ->assertStatus(401)
            ->assertJsonPath('error.code', 'session_revoked');
    }
}
