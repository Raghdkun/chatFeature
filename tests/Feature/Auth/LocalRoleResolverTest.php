<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\RoleResolver;
use App\Auth\Enums\UserRole;
use App\Auth\Roles\LocalRoleResolver;
use App\Models\User;
use Illuminate\Database\Events\QueryExecuted;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class LocalRoleResolverTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_container_hands_out_the_local_resolver_in_mode_one(): void
    {
        $this->assertInstanceOf(LocalRoleResolver::class, app(RoleResolver::class));
    }

    public function test_the_admin_role_sets_is_admin(): void
    {
        $user = User::factory()->create(['role' => UserRole::Admin, 'is_admin' => false, 'is_agent' => false]);

        (new LocalRoleResolver)->sync($user);

        $this->assertTrue($user->fresh()->is_admin);
    }

    public function test_an_admin_keeps_their_own_agent_choice(): void
    {
        $takesChats = User::factory()->create(['role' => UserRole::Admin, 'is_admin' => false, 'is_agent' => true]);
        $onlyManages = User::factory()->create(['role' => UserRole::Admin, 'is_admin' => false, 'is_agent' => false]);

        (new LocalRoleResolver)->sync($takesChats);
        (new LocalRoleResolver)->sync($onlyManages);

        $this->assertTrue($takesChats->fresh()->is_agent);
        $this->assertFalse($onlyManages->fresh()->is_agent);
        $this->assertTrue($onlyManages->fresh()->is_admin);
    }

    public function test_the_agent_role_makes_an_agent_and_revokes_admin(): void
    {
        $user = User::factory()->admin()->create();
        $user->forceFill(['role' => UserRole::Agent])->save();

        (new LocalRoleResolver)->sync($user);

        $fresh = $user->fresh();
        $this->assertFalse($fresh->is_admin);
        $this->assertTrue($fresh->is_agent);
    }

    public function test_it_does_not_write_when_nothing_changes(): void
    {
        $user = User::factory()->agent()->create();
        $writes = 0;
        DB::listen(function (QueryExecuted $query) use (&$writes): void {
            if (str_starts_with(strtolower($query->sql), 'update')) {
                $writes++;
            }
        });

        (new LocalRoleResolver)->sync($user);

        $this->assertSame(0, $writes);
    }

    public function test_flags_are_never_mass_assignable(): void
    {
        $user = User::query()->create([
            'name' => 'Mallory',
            'email' => 'mallory@example.test',
            'password' => 'password',
            'is_admin' => true,
            'is_agent' => true,
            'role' => 'admin',
            'is_active' => false,
        ])->fresh();

        $this->assertFalse($user->is_admin);
        $this->assertFalse($user->is_agent);
        $this->assertSame(UserRole::Agent, $user->role);
        $this->assertTrue($user->is_active);
    }
}
