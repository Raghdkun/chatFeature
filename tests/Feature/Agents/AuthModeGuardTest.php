<?php

namespace Tests\Feature\Agents;

use App\Auth\Enums\AuthMode;
use App\Domain\Agents\AuthModeGuard;
use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\InstallStateFake;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Account management is only open in mode 1, and the guard never guesses: on an installed instance whose `auth.mode`
 * is missing or unreadable it refuses (instead of falling back to the Fortify mode and letting admins create local
 * accounts next to a pizzasys portal).
 */
class AuthModeGuardTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private function brokenModeSetting(?string $json): void
    {
        Setting::query()->where('key', 'auth.mode')->delete();

        if ($json !== null) {
            Setting::query()->create(['group' => 'auth', 'key' => 'auth.mode', 'value' => $json, 'is_encrypted' => false]);
        }

        settings()->forget();
    }

    public function test_the_stored_mode_is_returned(): void
    {
        $this->useFortifyMode();
        $guard = app(AuthModeGuard::class);

        $this->assertSame(AuthMode::Fortify, $guard->mode());
        $this->assertTrue($guard->canManageStaff());

        $this->usePizzasysMode();
        $this->assertSame(AuthMode::Pizzasys, $guard->mode());
        $this->assertFalse($guard->canManageStaff());
    }

    public function test_a_missing_mode_on_an_installed_instance_fails_closed(): void
    {
        $this->brokenModeSetting(null);
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();

        $this->actingAs($admin, 'sanctum')
            ->postJson('/api/v1/agents', ['name' => 'N', 'email' => 'n@example.test', 'password' => 'a-long-test-password'])
            ->assertStatus(500)
            ->assertJsonPath('error.code', 'auth_mode_unavailable');
        $this->actingAs($admin, 'sanctum')
            ->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => false])
            ->assertStatus(500)
            ->assertJsonPath('error.code', 'auth_mode_unavailable');

        $this->assertDatabaseMissing('users', ['email' => 'n@example.test']);
        $this->assertTrue($agent->refresh()->is_active);
    }

    public function test_what_does_not_depend_on_the_mode_keeps_working(): void
    {
        $this->brokenModeSetting(null);
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();

        $this->actingAs($admin, 'sanctum')->getJson('/api/v1/agents')->assertOk();
        $this->actingAs($admin, 'sanctum')->patchJson('/api/v1/agents/'.$agent->id, ['max_concurrent_chats' => 4])->assertOk();
    }

    public function test_the_agents_page_refuses_to_guess_too(): void
    {
        $this->brokenModeSetting(null);
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->actingAs(User::factory()->admin()->create())->get('/agents')->assertStatus(500);
    }

    public function test_an_unrecognised_mode_fails_closed(): void
    {
        $this->brokenModeSetting('"ldap"');

        $this->expectExceptionMessage('The authentication mode is not configured');

        app(AuthModeGuard::class)->mode();
    }

    public function test_a_stored_null_is_unrecognised(): void
    {
        $this->brokenModeSetting('null');

        $this->expectExceptionMessage('The authentication mode is not configured');

        app(AuthModeGuard::class)->canManageStaff();
    }

    public function test_before_the_installation_is_complete_there_is_nothing_to_guard(): void
    {
        InstallStateFake::make(installed: false);

        $this->assertSame(AuthMode::Fortify, app(AuthModeGuard::class)->mode());
    }

    public function test_has_tells_a_stored_value_from_a_default(): void
    {
        $this->assertFalse(settings()->has('auth.mode'), 'the definition default is not a stored value');

        $this->useFortifyMode();

        $this->assertTrue(settings()->has('auth.mode'));
        $this->assertFalse(settings()->has('app.timezone'));
    }
}
