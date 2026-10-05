<?php

namespace Tests\Feature\Settings;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Inertia\Testing\AssertableInertia as Assert;
use Laravel\Fortify\Features;
use Tests\TestCase;

class SecurityTest extends TestCase
{
    use RefreshDatabase;

    public function test_security_page_is_displayed()
    {
        $this->skipUnlessFortifyHas(Features::twoFactorAuthentication());

        Features::twoFactorAuthentication([
            'confirm' => true,
            'confirmPassword' => true,
        ]);
        Features::passkeys([
            'confirmPassword' => true,
        ]);

        $user = User::factory()->create();

        $this->actingAs($user)
            ->withSession(['auth.password_confirmed_at' => time()])
            ->get(route('security.edit'))
            ->assertInertia(fn (Assert $page) => $page
                ->component('settings/security')
                ->where('canManagePasskeys', true)
                ->where('passkeys', [])
                ->where('canManageTwoFactor', true)
                ->where('twoFactorEnabled', false),
            );
    }

    public function test_a_wrong_confirmation_code_does_not_destroy_the_pending_two_factor_secret(): void
    {
        $this->skipUnlessFortifyHas(Features::twoFactorAuthentication());
        Features::twoFactorAuthentication(['confirm' => true, 'confirmPassword' => true]);

        $user = User::factory()->create();
        $this->actingAs($user)->withSession(['auth.password_confirmed_at' => time()]);

        // The real sequence: enable (a secret is stored), the Security page shows the QR code, a WRONG code is posted, the Security page loads again.
        $this->post(route('two-factor.enable'))->assertRedirect();
        $this->get(route('security.edit'))->assertOk();
        $this->assertNotNull($user->fresh()->two_factor_secret);

        $this->withSession(['two_factor_confirming_at' => time() - 10]); // Fortify counts real seconds (`time()`), Carbon's travel does not reach it: ten seconds into the setup
        $this->from(route('security.edit'))->post(route('two-factor.confirm'), ['code' => '000000'])->assertSessionHasErrors('code', null, 'confirmTwoFactorAuthentication');
        $this->get(route('security.edit'))->assertOk();

        $this->assertNotNull($user->fresh()->two_factor_secret, 'the authenticator holds this key: the retry must be able to use it');
    }

    public function test_a_setup_that_was_really_abandoned_is_still_cleaned_up(): void
    {
        $this->skipUnlessFortifyHas(Features::twoFactorAuthentication());
        Features::twoFactorAuthentication(['confirm' => true, 'confirmPassword' => true]);

        $user = User::factory()->create();
        $this->actingAs($user)->withSession(['auth.password_confirmed_at' => time()]);

        $this->post(route('two-factor.enable'))->assertRedirect();
        $this->get(route('security.edit'))->assertOk();
        $this->assertNotNull($user->fresh()->two_factor_secret);

        // The person leaves without confirming and comes back to the page much later.
        $this->withSession(['two_factor_confirming_at' => time() - 1000]);
        $this->get(route('security.edit'))->assertOk();

        $this->assertNull($user->fresh()->two_factor_secret);
    }

    public function test_security_page_requires_password_confirmation_when_enabled()
    {
        $this->skipUnlessFortifyHas(Features::twoFactorAuthentication());

        $user = User::factory()->create();

        Features::twoFactorAuthentication([
            'confirm' => true,
            'confirmPassword' => true,
        ]);

        $response = $this->actingAs($user)
            ->get(route('security.edit'));

        $response->assertRedirect(route('password.confirm'));
    }

    public function test_security_page_renders_without_two_factor_when_feature_is_disabled()
    {
        $this->skipUnlessFortifyHas(Features::twoFactorAuthentication());

        config(['fortify.features' => []]);

        $user = User::factory()->create();

        $this->actingAs($user)
            ->withSession(['auth.password_confirmed_at' => time()])
            ->get(route('security.edit'))
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->component('settings/security')
                ->where('canManagePasskeys', false)
                ->where('passkeys', [])
                ->where('canManageTwoFactor', false)
                ->missing('twoFactorEnabled')
                ->missing('requiresConfirmation'),
            );
    }

    public function test_password_can_be_updated()
    {
        $user = User::factory()->create();

        $response = $this
            ->actingAs($user)
            ->from(route('security.edit'))
            ->put(route('user-password.update'), [
                'current_password' => 'password',
                'password' => 'new-password',
                'password_confirmation' => 'new-password',
            ]);

        $response
            ->assertSessionHasNoErrors()
            ->assertRedirect(route('security.edit'));

        $this->assertTrue(Hash::check('new-password', $user->refresh()->password));
    }

    public function test_correct_password_must_be_provided_to_update_password()
    {
        $user = User::factory()->create();

        $response = $this
            ->actingAs($user)
            ->from(route('security.edit'))
            ->put(route('user-password.update'), [
                'current_password' => 'wrong-password',
                'password' => 'new-password',
                'password_confirmation' => 'new-password',
            ]);

        $response
            ->assertSessionHasErrors('current_password')
            ->assertRedirect(route('security.edit'));
    }
}
