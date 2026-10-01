<?php

namespace Tests\Feature\Agents;

use App\Models\Category;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Only accounts that take chats (`is_agent`) serve categories: chat routing offers a chat to the users serving its
 * category, and an admin who does not take chats must never be one of them.
 */
class AgentCategoryAssignmentTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->admin = User::factory()->admin()->create();
    }

    private function asAdmin(): static
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    private function nonAgentAdmin(): User
    {
        return User::factory()->admin()->create(['is_agent' => false]);
    }

    public function test_an_admin_who_does_not_take_chats_cannot_be_given_categories(): void
    {
        $colleague = $this->nonAgentAdmin();
        $category = Category::factory()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id.'/categories', ['category_ulids' => [$category->ulid]])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'not_an_agent');

        $this->assertSame(0, DB::table('category_user')->where('user_id', $colleague->id)->count());
        $this->assertDatabaseMissing('audit_logs', ['action' => 'agent.categories_updated', 'subject_id' => (string) $colleague->id]);
    }

    public function test_agents_and_admins_who_take_chats_can_be_given_categories(): void
    {
        $agent = User::factory()->agent()->create();
        $workingAdmin = User::factory()->admin()->create();
        $category = Category::factory()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => [$category->ulid]])->assertOk()->assertJsonPath('data.category_ulids', [$category->ulid]);
        $this->asAdmin()->patchJson('/api/v1/agents/'.$workingAdmin->id.'/categories', ['category_ulids' => [$category->ulid]])->assertOk();

        $this->assertSame(2, DB::table('category_user')->where('category_id', $category->id)->count());
    }

    public function test_an_inactive_agent_can_still_be_prepared(): void
    {
        $agent = User::factory()->agent()->inactive()->create();
        $category = Category::factory()->create();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id.'/categories', ['category_ulids' => [$category->ulid]])->assertOk();
    }

    public function test_users_who_are_not_staff_stay_unknown(): void
    {
        $this->asAdmin()->patchJson('/api/v1/agents/'.User::factory()->withoutChatAccess()->create()->id.'/categories', ['category_ulids' => []])->assertNotFound();
        $this->asAdmin()->patchJson('/api/v1/agents/999999/categories', ['category_ulids' => []])->assertNotFound();
    }

    public function test_switching_off_taking_chats_drops_the_categories_the_account_served(): void
    {
        $colleague = User::factory()->admin()->create();
        $category = Category::factory()->create();
        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id.'/categories', ['category_ulids' => [$category->ulid]])->assertOk();

        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id, ['is_agent' => false])
            ->assertOk()
            ->assertJsonPath('data.is_agent', false)
            ->assertJsonPath('data.category_ulids', []);

        $this->assertSame(0, DB::table('category_user')->where('user_id', $colleague->id)->count());
        // ... and they can not be given new ones until they take chats again.
        $this->asAdmin()->patchJson('/api/v1/agents/'.$colleague->id.'/categories', ['category_ulids' => [$category->ulid]])->assertStatus(409);
    }

    public function test_other_changes_keep_the_categories(): void
    {
        $agent = User::factory()->agent()->create();
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);

        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['max_concurrent_chats' => 7])->assertOk()->assertJsonPath('data.category_ulids', [$category->ulid]);
        $this->asAdmin()->patchJson('/api/v1/agents/'.$agent->id, ['is_active' => false])->assertOk()->assertJsonPath('data.category_ulids', [$category->ulid]);
    }

    public function test_a_leftover_assignment_of_a_non_agent_is_not_counted_as_an_agent(): void
    {
        $category = Category::factory()->create();
        $agent = User::factory()->agent()->create();
        $colleague = $this->nonAgentAdmin();
        $category->users()->attach([$agent->id, $colleague->id]);

        $this->asAdmin()->getJson('/api/v1/categories')->assertOk()->assertJsonPath('data.0.agents_count', 1);
    }
}
