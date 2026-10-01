<?php

namespace Tests\Feature\Auth;

use App\Auth\Contracts\RoleResolver;
use App\Auth\Enums\UserRole;
use App\Auth\Roles\LocalRoleResolver;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Auth\Roles\RoleMapping;
use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PizzasysRoleResolverTest extends TestCase
{
    use RefreshDatabase;

    private function resolver(): PizzasysRoleResolver
    {
        return app(PizzasysRoleResolver::class);
    }

    public function test_the_binding_follows_the_auth_mode(): void
    {
        $this->assertInstanceOf(LocalRoleResolver::class, app(RoleResolver::class));

        settings()->set('auth.mode', 'pizzasys');

        $this->assertInstanceOf(PizzasysRoleResolver::class, app(RoleResolver::class));
    }

    public function test_a_super_role_is_an_admin_even_though_it_carries_no_chat_permission(): void
    {
        $decision = $this->resolver()->decide(['super-admin'], ['manage users', 'manage roles']);

        $this->assertTrue($decision->isAdmin);
        $this->assertTrue($decision->isAgent, 'admins are agents too, like in mode 1');
    }

    public function test_the_admin_permission_is_an_admin(): void
    {
        $decision = $this->resolver()->decide([], ['chat.admin']);

        $this->assertTrue($decision->isAdmin);
        $this->assertTrue($decision->isAgent);
    }

    public function test_the_agent_permission_is_an_agent_only(): void
    {
        $decision = $this->resolver()->decide(['chat-agent-role'], ['chat.agent']);

        $this->assertFalse($decision->isAdmin);
        $this->assertTrue($decision->isAgent);
        $this->assertTrue($decision->hasChatAccess());
    }

    public function test_nothing_relevant_means_no_chat_access(): void
    {
        $decision = $this->resolver()->decide(['sales'], ['manage users']);

        $this->assertFalse($decision->isAdmin);
        $this->assertFalse($decision->isAgent);
        $this->assertFalse($decision->hasChatAccess());
    }

    public function test_the_names_come_from_the_settings(): void
    {
        settings()->set('auth.pizzasys.admin_permission', 'support.manager');
        settings()->set('auth.pizzasys.agent_permission', 'support.agent');
        settings()->set('auth.pizzasys.super_roles', ['owner', 'root']);

        $this->assertTrue($this->resolver()->decide([], ['support.manager'])->isAdmin);
        $this->assertTrue($this->resolver()->decide([], ['support.agent'])->isAgent);
        $this->assertTrue($this->resolver()->decide(['root'], [])->isAdmin);
        $this->assertFalse($this->resolver()->decide(['super-admin'], ['chat.admin', 'chat.agent'])->hasChatAccess(), 'the defaults no longer apply');
    }

    public function test_an_empty_name_never_matches(): void
    {
        $mapping = new RoleMapping('', '', []);

        $this->assertFalse($this->resolver()->decide([], [''], $mapping)->hasChatAccess());
    }

    public function test_an_explicit_mapping_overrides_the_settings(): void
    {
        $decision = $this->resolver()->decide([], ['wizard.admin'], new RoleMapping('wizard.admin', 'wizard.agent', []));

        $this->assertTrue($decision->isAdmin);
    }

    public function test_sync_persists_the_flags_of_the_active_environment_identity(): void
    {
        $environment = AuthEnvironment::factory()->production()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->withoutChatAccess()->create(['auth_source' => 'pizzasys']);
        UserExternalIdentity::factory()->granting(['super-admin'], [])->create(['user_id' => $user->id, 'auth_environment_id' => $environment->id]);

        $this->resolver()->sync($user);

        $user->refresh();
        $this->assertTrue($user->is_admin);
        $this->assertTrue($user->is_agent);
        $this->assertSame(UserRole::Admin, $user->role);
    }

    public function test_sync_demotes_when_the_portal_took_the_roles_away_and_revokes_api_tokens(): void
    {
        $environment = AuthEnvironment::factory()->production()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->admin()->create(['auth_source' => 'pizzasys']);
        $user->createToken('phone', ['staff']);
        UserExternalIdentity::factory()->granting([], [])->create(['user_id' => $user->id, 'auth_environment_id' => $environment->id]);

        $this->resolver()->sync($user);

        $user->refresh();
        $this->assertFalse($user->is_admin);
        $this->assertFalse($user->is_agent);
        $this->assertSame(0, $user->tokens()->count(), 'losing every chat role deletes the Sanctum tokens');
    }

    public function test_sync_only_looks_at_the_active_environment(): void
    {
        $production = AuthEnvironment::factory()->production()->create();
        $testing = AuthEnvironment::factory()->testing()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->withoutChatAccess()->create(['auth_source' => 'pizzasys']);
        UserExternalIdentity::factory()->granting(['super-admin'], [])->create(['user_id' => $user->id, 'auth_environment_id' => $testing->id]);
        UserExternalIdentity::factory()->granting([], ['chat.agent'])->create(['user_id' => $user->id, 'auth_environment_id' => $production->id]);

        $this->resolver()->sync($user);

        $user->refresh();
        $this->assertFalse($user->is_admin, 'the testing environment is not active');
        $this->assertTrue($user->is_agent);

        settings()->set('auth.pizzasys.active_env', 'testing');
        $this->resolver()->sync($user);

        $this->assertTrue($user->refresh()->is_admin);
    }

    public function test_sync_leaves_users_without_an_identity_alone(): void
    {
        AuthEnvironment::factory()->production()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->agent()->create();

        $this->resolver()->sync($user);

        $this->assertTrue($user->refresh()->is_agent);
    }

    public function test_sync_ignores_deactivated_identities(): void
    {
        $environment = AuthEnvironment::factory()->production()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->withoutChatAccess()->create();
        UserExternalIdentity::factory()->granting(['super-admin'], [])->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $environment->id]);

        $this->resolver()->sync($user);

        $this->assertFalse($user->refresh()->is_admin);
    }

    public function test_sync_from_identity_applies_exactly_the_identity_it_is_given(): void
    {
        $environment = AuthEnvironment::factory()->production()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->withoutChatAccess()->create(['auth_source' => 'pizzasys']);
        // A deactivated admin identity of the same user sits next to the live agent identity.
        UserExternalIdentity::factory()->granting(['super-admin'], [])->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $environment->id, 'external_id' => '1']);
        $agent = UserExternalIdentity::factory()->granting([], ['chat.agent'])->create(['user_id' => $user->id, 'auth_environment_id' => $environment->id, 'external_id' => '2']);

        $this->resolver()->syncFromIdentity($user, $agent);

        $user->refresh();
        $this->assertFalse($user->is_admin, 'roles of another identity of the same user never leak in');
        $this->assertTrue($user->is_agent);
    }

    public function test_sync_from_identity_ignores_identities_that_are_not_valid_for_this_user_and_environment(): void
    {
        $production = AuthEnvironment::factory()->production()->create();
        $testing = AuthEnvironment::factory()->testing()->create();
        settings()->set('auth.mode', 'pizzasys');
        $user = User::factory()->withoutChatAccess()->create(['auth_source' => 'pizzasys']);
        $other = User::factory()->create(['auth_source' => 'pizzasys']);

        $inactiveEnvironment = UserExternalIdentity::factory()->granting(['super-admin'], [])->create(['user_id' => $user->id, 'auth_environment_id' => $testing->id]);
        $deactivated = UserExternalIdentity::factory()->granting(['super-admin'], [])->deactivated()->create(['user_id' => $user->id, 'auth_environment_id' => $production->id]);
        $foreign = UserExternalIdentity::factory()->granting(['super-admin'], [])->create(['user_id' => $other->id, 'auth_environment_id' => $production->id]);

        foreach ([$inactiveEnvironment, $deactivated, $foreign] as $identity) {
            $this->resolver()->syncFromIdentity($user, $identity);
        }

        $user->refresh();
        $this->assertFalse($user->is_admin);
        $this->assertFalse($user->is_agent);
    }
}
