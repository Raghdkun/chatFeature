<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * A password change or reset ends the pages of every other session of the account (the stateful API calls already did). Before, only
 * the background requests of an old tab got 401 while its pages kept answering, and the tab reloaded itself in a loop.
 */
class PasswordChangeEndsSessionsTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_a_session_whose_password_was_changed_elsewhere_is_signed_out_on_its_next_page(): void
    {
        $user = User::factory()->admin()->create();

        $this->actingAs($user)->get('/dashboard')->assertOk();

        // The password is changed from another browser (or reset through the e-mail link).
        $user->forceFill(['password' => Hash::make('A-brand-new-password-1')])->save();

        $this->get('/dashboard')->assertRedirect(route('login'));
        $this->assertGuest();
    }

    public function test_the_session_of_the_person_who_changes_the_password_stays_signed_in(): void
    {
        $user = User::factory()->admin()->create();

        $this->actingAs($user)->withSession(['auth.password_confirmed_at' => time()])->get('/dashboard')->assertOk();

        $this->from(route('security.edit'))->put(route('user-password.update'), [
            'current_password' => 'password',
            'password' => 'A-brand-new-password-1',
            'password_confirmation' => 'A-brand-new-password-1',
        ])->assertSessionHasNoErrors();

        $this->get('/dashboard')->assertOk();
        $this->assertAuthenticatedAs($user);
    }

    public function test_a_session_of_a_portal_account_without_a_local_password_is_not_affected(): void
    {
        $user = User::factory()->admin()->create(['password' => null]);

        $this->actingAs($user)->get('/dashboard')->assertOk();
        $this->get('/dashboard')->assertOk();
    }
}
