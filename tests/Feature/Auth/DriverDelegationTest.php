<?php

namespace Tests\Feature\Auth;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\AuthCapabilities;
use App\Auth\Support\AuthResult;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery;
use Mockery\MockInterface;
use Tests\TestCase;

/**
 * Login is delegated to whichever AuthDriver `auth.mode` selects (the seam P2's PizzasysDriver plugs into).
 */
class DriverDelegationTest extends TestCase
{
    use RefreshDatabase;

    private function useStubDriver(): MockInterface
    {
        /** @var MockInterface&AuthDriver $driver */
        $driver = Mockery::mock(AuthDriver::class);
        $driver->shouldReceive('key')->andReturn('pizzasys');
        $driver->shouldReceive('capabilities')->andReturn(new AuthCapabilities(false, false, false, false, 'https://portal.example'));
        $driver->shouldReceive('validateSession')->andReturn(SessionVerdict::Fresh);

        settings()->set('auth.mode', 'pizzasys');
        app(AuthModeManager::class)->extend('pizzasys', fn () => $driver);

        return $driver;
    }

    public function test_the_manager_switches_driver_with_the_auth_mode_setting(): void
    {
        $stub = $this->useStubDriver();

        $this->assertSame($stub, app(AuthDriver::class));

        settings()->set('auth.mode', 'fortify');
        $this->assertSame('fortify', app(AuthModeManager::class)->activeDriver()->key());
    }

    public function test_the_login_form_signs_in_whoever_the_active_driver_vouches_for(): void
    {
        $user = User::factory()->create(['auth_source' => 'pizzasys']);
        $this->useStubDriver()->shouldReceive('attempt')->once()->andReturn(AuthResult::ok($user));

        $this->post(route('login.store'), ['email' => 'portal@example.test', 'password' => 'portal-password'])
            ->assertRedirect(route('dashboard', absolute: false));

        $this->assertAuthenticatedAs($user);
    }

    public function test_an_invalid_verdict_is_the_generic_login_failure(): void
    {
        $this->useStubDriver()->shouldReceive('attempt')->andReturn(AuthResult::invalid());

        $this->post(route('login.store'), ['email' => 'a@example.test', 'password' => 'x'])
            ->assertSessionHasErrors(['email' => trans('auth.failed')]);

        $this->assertGuest();
    }

    public function test_an_unavailable_driver_tells_the_user_to_try_again_later(): void
    {
        $this->useStubDriver()->shouldReceive('attempt')->andReturn(AuthResult::unavailable());

        $this->post(route('login.store'), ['email' => 'a@example.test', 'password' => 'x'])
            ->assertSessionHasErrors('email');

        $this->assertGuest();
    }

    public function test_a_no_chat_access_verdict_carries_its_message(): void
    {
        $user = User::factory()->withoutChatAccess()->create();
        $this->useStubDriver()->shouldReceive('attempt')->andReturn(AuthResult::noChatAccess($user, 'Your portal account has no chat role.'));

        $this->post(route('login.store'), ['email' => $user->email, 'password' => 'x'])
            ->assertSessionHasErrors(['email' => 'Your portal account has no chat role.']);

        $this->assertGuest();
    }

    public function test_the_driver_is_asked_once_per_login_even_with_two_factor(): void
    {
        $user = User::factory()->withTwoFactor()->create();
        // Fortify consults the authenticate callback twice (2FA redirect, then the attempt): the verdict is memoised.
        $this->useStubDriver()->shouldReceive('attempt')->once()->andReturn(AuthResult::ok($user));

        $this->post(route('login'), ['email' => $user->email, 'password' => 'x'])
            ->assertRedirect(route('two-factor.login'));

        $this->assertGuest();
    }

    public function test_the_login_page_reflects_the_driver_capabilities(): void
    {
        $this->useStubDriver();

        $this->get(route('login'))->assertInertia(fn ($page) => $page
            ->where('canRegister', false)
            ->where('canResetPassword', false)
            ->where('auth.capabilities.portalUrl', 'https://portal.example'));
    }
}
