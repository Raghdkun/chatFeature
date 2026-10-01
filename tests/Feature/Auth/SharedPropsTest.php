<?php

namespace Tests\Feature\Auth;

use App\Domain\Install\InstallState;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

/**
 * Asserts docs/contracts/inertia-shared-props.md through real pages.
 */
class SharedPropsTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_signed_in_page_gets_exactly_the_contract_props(): void
    {
        $user = User::factory()->agent()->create(['name' => 'Ada', 'email' => 'ada@example.test']);

        $this->actingAs($user)->get(route('dashboard'))->assertInertia(fn (Assert $page) => $page
            ->component('dashboard')
            ->hasAll(['name', 'auth', 'locale', 'direction', 'installed', 'sidebarOpen', 'flash', 'errors'])
            ->where('name', config('app.name'))
            ->where('locale', 'en')
            ->where('direction', 'ltr')
            ->where('installed', true)
            ->where('sidebarOpen', true)
            ->where('flash', [])
            ->where('auth.mode', 'fortify')
            ->where('auth.user', [
                'id' => $user->id,
                'name' => 'Ada',
                'email' => 'ada@example.test',
                'avatar' => null,
                'is_admin' => false,
                'is_agent' => true,
                'auth_source' => 'local',
            ])
            ->where('auth.capabilities', [
                'canRegister' => false,
                'canResetPassword' => true,
                'canManage2fa' => true,
                'profileEditable' => true,
                'portalUrl' => null,
            ]));
    }

    public function test_the_user_payload_never_leaks_secrets_or_internals(): void
    {
        $user = User::factory()->admin()->withTwoFactor()->create();

        $props = $this->actingAs($user)->get(route('dashboard'))->inertiaProps();

        $this->assertSame(['id', 'name', 'email', 'avatar', 'is_admin', 'is_agent', 'auth_source'], array_keys($props['auth']['user']));
        $this->assertSame(['canRegister', 'canResetPassword', 'canManage2fa', 'profileEditable', 'portalUrl'], array_keys($props['auth']['capabilities']));

        $json = (string) json_encode($props);
        foreach (['password', 'two_factor_secret', 'two_factor_recovery_codes', 'remember_token', 'external_id', 'workspace_id'] as $secret) {
            $this->assertStringNotContainsString($secret, $json);
        }
    }

    public function test_guests_get_a_null_user_and_the_login_variant_props(): void
    {
        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page
            ->where('auth.user', null)
            ->where('auth.mode', 'fortify')
            ->where('installed', true)
            ->has('auth.capabilities'));
    }

    public function test_the_app_name_comes_from_settings(): void
    {
        settings()->set('app.name', 'Acme Support');

        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page->where('name', 'Acme Support'));
    }

    public function test_the_sidebar_state_cookie_is_honoured(): void
    {
        $user = User::factory()->create();

        $this->actingAs($user)->withUnencryptedCookie('sidebar_state', 'false')->get(route('dashboard'))
            ->assertInertia(fn (Assert $page) => $page->where('sidebarOpen', false));
    }

    public function test_locale_and_direction_follow_the_user_then_the_workspace_setting(): void
    {
        settings()->set('app.locale', 'ar');
        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page->where('locale', 'ar')->where('direction', 'rtl'));

        $user = User::factory()->create(['locale' => 'en']);
        $this->actingAs($user)->get(route('dashboard'))->assertInertia(fn (Assert $page) => $page->where('locale', 'en')->where('direction', 'ltr'));

        $arabic = User::factory()->create(['locale' => 'ar']);
        $this->actingAs($arabic)->get(route('dashboard'))->assertInertia(fn (Assert $page) => $page->where('locale', 'ar')->where('direction', 'rtl'));
    }

    public function test_an_unsupported_user_locale_is_ignored(): void
    {
        $user = User::factory()->create(['locale' => 'xx']);

        $this->actingAs($user)->get(route('dashboard'))->assertInertia(fn (Assert $page) => $page->where('locale', 'en'));
    }

    public function test_flash_messages_are_shared(): void
    {
        $this->withSession(['success' => 'Saved.', 'error' => 'Nope.'])
            ->get(route('login'))
            ->assertInertia(fn (Assert $page) => $page->where('flash', ['success' => 'Saved.', 'error' => 'Nope.']));

        $this->flushSession();
        $this->withSession(['success' => 'Saved.'])
            ->get(route('login'))
            ->assertInertia(fn (Assert $page) => $page->where('flash', ['success' => 'Saved.']));
    }

    public function test_an_avatar_is_shared_as_a_url(): void
    {
        $user = User::factory()->create(['avatar_path' => 'avatars/ada.png']);

        $this->actingAs($user)->get(route('dashboard'))->assertInertia(fn (Assert $page) => $page
            ->where('auth.user.avatar', fn (string $url) => str_ends_with($url, '/storage/avatars/ada.png')));
    }

    public function test_before_install_the_props_are_database_free_guest_props(): void
    {
        InstallState::fake(installed: false);
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);

        $this->get(route('setup.index'))->assertInertia(fn (Assert $page) => $page
            ->where('installed', false)
            ->where('auth.user', null)
            ->where('auth.mode', 'fortify')
            ->where('name', config('app.name'))
            ->where('locale', 'en')
            ->where('direction', 'ltr')
            ->where('flash', [])
            ->has('auth.capabilities')
            ->has('sidebarOpen'));
    }
}
