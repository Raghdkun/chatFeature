<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class ChatAccessTest extends TestCase
{
    use RefreshDatabase;

    public function test_a_user_without_a_role_cannot_log_in_and_sees_why(): void
    {
        User::factory()->withoutChatAccess()->create(['email' => 'nobody@example.test']);

        $this->post(route('login.store'), ['email' => 'nobody@example.test', 'password' => 'password'])
            ->assertSessionHasErrors(['email' => 'This account has no access to the chat dashboard. Ask an administrator to grant it.']);

        $this->assertGuest();
    }

    public function test_a_deactivated_user_cannot_log_in(): void
    {
        User::factory()->inactive()->create(['email' => 'gone@example.test']);

        $this->post(route('login.store'), ['email' => 'gone@example.test', 'password' => 'password'])
            ->assertSessionHasErrors('email');

        $this->assertGuest();
    }

    public function test_agents_and_admins_can_log_in_and_reach_the_dashboard(): void
    {
        foreach ([User::factory()->agent()->create(), User::factory()->admin()->create()] as $user) {
            $this->post(route('login.store'), ['email' => $user->email, 'password' => 'password'])
                ->assertRedirect(route('dashboard', absolute: false));
            $this->assertAuthenticatedAs($user);
            $this->get(route('dashboard'))->assertOk();
            $this->post(route('logout'));
        }
    }

    public function test_wrong_credentials_keep_the_generic_error(): void
    {
        $user = User::factory()->create();

        $this->post(route('login.store'), ['email' => $user->email, 'password' => 'wrong'])
            ->assertSessionHasErrors(['email' => trans('auth.failed')]);
    }

    public function test_a_signed_in_user_who_lost_access_is_signed_out_with_a_clear_message(): void
    {
        $user = User::factory()->withoutChatAccess()->create();

        $this->actingAs($user)
            ->get(route('dashboard'))
            ->assertRedirect(route('login'))
            ->assertSessionHas('error', 'This account has no access to the chat dashboard. Ask an administrator to grant it.');

        $this->assertGuest();
    }

    public function test_this_also_covers_passkey_or_two_factor_sessions_on_other_pages(): void
    {
        $user = User::factory()->withoutChatAccess()->create();

        $this->actingAs($user)->get(route('profile.edit'))->assertRedirect(route('login'));
        $this->assertGuest();
    }

    public function test_json_clients_get_403_with_an_error_code(): void
    {
        Route::middleware(['web', 'auth'])->get('/_probe/json', fn () => ['ok' => true]);
        $user = User::factory()->withoutChatAccess()->create();

        $this->actingAs($user)
            ->getJson('/_probe/json')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'no_chat_access');
    }

    public function test_the_chat_access_alias_can_guard_api_groups(): void
    {
        Route::middleware(['auth', 'chat.access'])->get('/_probe/api', fn () => ['ok' => true]);

        $this->actingAs(User::factory()->withoutChatAccess()->create())
            ->getJson('/_probe/api')
            ->assertForbidden()
            ->assertJsonPath('error.code', 'no_chat_access');

        $this->actingAs(User::factory()->agent()->create())
            ->getJson('/_probe/api')
            ->assertOk();
    }

    public function test_such_a_user_can_still_log_out(): void
    {
        $user = User::factory()->withoutChatAccess()->create();

        $this->actingAs($user)->post(route('logout'))->assertRedirect(route('home'));

        $this->assertGuest();
    }

    public function test_deactivating_an_account_ends_its_existing_sessions(): void
    {
        $user = User::factory()->agent()->create();
        $this->actingAs($user)->get(route('dashboard'))->assertOk();

        $user->forceFill(['is_active' => false])->save();

        $this->actingAs($user->fresh())
            ->get(route('dashboard'))
            ->assertRedirect(route('login'))
            ->assertSessionHas('error');
        $this->assertGuest();
    }

    public function test_a_reactivated_account_with_access_works_again(): void
    {
        $user = User::factory()->inactive()->create();
        $user->forceFill(['is_active' => true])->save();

        $this->actingAs($user->fresh())->get(route('dashboard'))->assertOk();
    }

    public function test_guests_are_unaffected(): void
    {
        $this->get(route('login'))->assertOk();
        $this->get(route('dashboard'))->assertRedirect(route('login'));
    }
}
