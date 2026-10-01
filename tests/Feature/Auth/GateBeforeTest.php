<?php

namespace Tests\Feature\Auth;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Gate;
use Tests\TestCase;

class GateBeforeTest extends TestCase
{
    use RefreshDatabase;

    public function test_admins_pass_every_gate_check(): void
    {
        $admin = User::factory()->admin()->create();

        $this->assertTrue(Gate::forUser($admin)->allows('anything-at-all'));
        $this->assertTrue(Gate::forUser($admin)->allows('manage-widgets', [new \stdClass]));
    }

    public function test_agents_and_users_without_access_fall_through_to_the_normal_rules(): void
    {
        Gate::define('manage-widgets', fn (User $user): bool => false);
        Gate::define('reply', fn (User $user): bool => $user->is_agent);

        $agent = User::factory()->agent()->create();
        $nobody = User::factory()->withoutChatAccess()->create();

        $this->assertFalse(Gate::forUser($agent)->allows('manage-widgets'));
        $this->assertTrue(Gate::forUser($agent)->allows('reply'));
        $this->assertFalse(Gate::forUser($nobody)->allows('reply'));
        $this->assertFalse(Gate::forUser($agent)->allows('undefined-ability'));
    }

    public function test_a_deactivated_admin_gets_no_special_treatment(): void
    {
        $admin = User::factory()->admin()->inactive()->create();

        $this->assertFalse(Gate::forUser($admin)->allows('anything-at-all'));
    }

    public function test_guests_are_not_granted_anything(): void
    {
        $this->assertFalse(Gate::forUser(null)->allows('anything-at-all'));
    }
}
