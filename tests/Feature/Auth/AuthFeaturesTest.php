<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Support\AuthCapabilities;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Mockery;
use Tests\TestCase;

/**
 * The active driver's capabilities decide which Fortify routes are reachable.
 */
class AuthFeaturesTest extends TestCase
{
    use RefreshDatabase;

    private function driverWith(AuthCapabilities $capabilities): void
    {
        $driver = Mockery::mock(AuthDriver::class);
        $driver->shouldReceive('capabilities')->andReturn($capabilities);
        $driver->shouldReceive('key')->andReturn('fortify');
        $driver->shouldReceive('validateSession')->andReturn(SessionVerdict::Fresh);
        $this->app->instance(AuthDriver::class, $driver);
    }

    public function test_registration_follows_the_allow_registration_setting(): void
    {
        $this->get(route('register'))->assertNotFound();

        settings()->set('auth.allow_registration', true);
        $this->get(route('register'))->assertOk();

        settings()->set('auth.allow_registration', false);
        $this->get(route('register'))->assertNotFound();
    }

    public function test_the_login_page_receives_the_capability_flags(): void
    {
        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page
            ->component('auth/login')
            ->where('canRegister', false)
            ->where('canResetPassword', true));

        settings()->set('auth.allow_registration', true);
        $this->get(route('login'))->assertInertia(fn (Assert $page) => $page->where('canRegister', true));
    }

    public function test_password_reset_stays_available_in_mode_one(): void
    {
        $this->get(route('password.request'))->assertOk();
    }

    public function test_a_driver_that_cannot_reset_passwords_removes_those_routes(): void
    {
        $this->driverWith(new AuthCapabilities(true, false, true, true, null));

        $this->get(route('password.request'))->assertNotFound();
        $this->post(route('password.email'), ['email' => 'a@b.test'])->assertNotFound();
        $this->get(route('password.reset', 'token'))->assertNotFound();
        $this->get(route('register'))->assertOk();
    }

    public function test_a_driver_that_cannot_manage_two_factor_removes_enrolment_but_not_the_challenge(): void
    {
        $this->driverWith(new AuthCapabilities(false, false, false, false, 'https://portal.example'));
        $user = User::factory()->create();

        $this->actingAs($user)
            ->withSession(['auth.password_confirmed_at' => time()])
            ->post(route('two-factor.enable'))
            ->assertNotFound();

        $this->get(route('passkey.registration-options'))->assertNotFound();

        // signing in with an existing second factor must keep working: the challenge route is not blocked
        $this->post(route('logout'));
        $this->get(route('two-factor.login'))->assertRedirect(route('login'));
    }
}
