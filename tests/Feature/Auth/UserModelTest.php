<?php

namespace Tests\Feature\Auth;

use App\Auth\Enums\UserRole;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class UserModelTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_users_table_has_the_staff_columns_and_the_agent_index(): void
    {
        foreach ([
            'workspace_id', 'role', 'is_admin', 'is_agent', 'is_active', 'display_name', 'avatar_path',
            'locale', 'timezone', 'max_concurrent_chats', 'last_seen_at', 'auth_source',
        ] as $column) {
            $this->assertTrue(Schema::hasColumn('users', $column), "users.{$column} is missing");
        }

        $indexes = collect(Schema::getIndexes('users'))->pluck('columns');
        $this->assertTrue($indexes->contains(['is_active', 'is_agent']));

        $password = collect(Schema::getColumns('users'))->firstWhere('name', 'password');
        $this->assertTrue($password['nullable'], 'external-portal users have no local password');
    }

    public function test_a_new_user_gets_safe_defaults(): void
    {
        $user = User::query()->create(['name' => 'N', 'email' => 'n@example.test', 'password' => 'password']);

        $this->assertSame(UserRole::Agent, $user->role);
        $this->assertFalse($user->is_admin);
        $this->assertFalse($user->is_agent);
        $this->assertTrue($user->is_active);
        $this->assertSame(5, $user->max_concurrent_chats);
        $this->assertSame('local', $user->auth_source);
        $this->assertNull($user->workspace_id);
        $this->assertNull($user->last_seen_at);
        $this->assertFalse($user->hasChatAccess());

        $fresh = $user->fresh();
        $this->assertSame(5, $fresh->max_concurrent_chats);
        $this->assertTrue($fresh->is_active);
    }

    public function test_users_without_a_password_can_exist(): void
    {
        $user = User::factory()->create(['password' => null, 'auth_source' => 'pizzasys']);

        $this->assertNull($user->fresh()->password);
        $this->assertSame('pizzasys', $user->fresh()->auth_source);
    }

    public function test_factory_states(): void
    {
        $default = User::factory()->create();
        $admin = User::factory()->admin()->create();
        $agent = User::factory()->agent()->create();
        $nobody = User::factory()->withoutChatAccess()->create();
        $inactive = User::factory()->inactive()->create();

        $this->assertTrue($default->is_agent);
        $this->assertFalse($default->is_admin);
        $this->assertTrue($default->hasChatAccess());

        $this->assertSame(UserRole::Admin, $admin->role);
        $this->assertTrue($admin->is_admin);
        $this->assertTrue($admin->is_agent);

        $this->assertSame(UserRole::Agent, $agent->role);
        $this->assertFalse($agent->is_admin);
        $this->assertTrue($agent->is_agent);

        $this->assertFalse($nobody->hasChatAccess());
        $this->assertFalse($inactive->is_active);
    }

    public function test_label_and_avatar_accessors(): void
    {
        $user = User::factory()->create(['name' => 'Ada Lovelace', 'display_name' => null, 'avatar_path' => null]);
        $this->assertSame('Ada Lovelace', $user->label);
        $this->assertNull($user->avatar_url);

        $user->display_name = 'Ada from Support';
        $user->avatar_path = 'avatars/ada.png';
        $this->assertSame('Ada from Support', $user->label);
        $this->assertStringEndsWith('/storage/avatars/ada.png', (string) $user->avatar_url);
    }

    public function test_it_can_issue_sanctum_tokens(): void
    {
        $user = User::factory()->create();

        $token = $user->createToken('phone');

        $this->assertNotEmpty($token->plainTextToken);
        $this->assertCount(1, $user->tokens);
    }

    public function test_secrets_stay_hidden_when_serialised(): void
    {
        $array = User::factory()->withTwoFactor()->create()->toArray();

        foreach (['password', 'two_factor_secret', 'two_factor_recovery_codes', 'remember_token'] as $key) {
            $this->assertArrayNotHasKey($key, $array);
        }
    }
}
