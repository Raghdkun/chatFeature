<?php

namespace Tests\Feature\Catalog;

use App\Models\Category;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class MeCategoriesTest extends TestCase
{
    use RefreshDatabase;

    public function test_an_agent_chooses_the_categories_they_serve(): void
    {
        $agent = User::factory()->agent()->create();
        [$billing, $sales, $support] = Category::factory()->count(3)->create()->all();

        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/me/categories')->assertOk()->assertExactJson(['data' => ['category_ulids' => []]]);

        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => [$billing->ulid, $sales->ulid]])
            ->assertOk()
            ->assertExactJson(['data' => ['category_ulids' => [$billing->ulid, $sales->ulid]]]);

        // Replaces, not merges.
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => [$support->ulid, $sales->ulid]])->assertOk();
        $this->assertEqualsCanonicalizing([$sales->ulid, $support->ulid], $this->actingAs($agent, 'sanctum')->getJson('/api/v1/me/categories')->json('data.category_ulids'));

        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => []])->assertOk()->assertJsonPath('data.category_ulids', []);
        $this->assertDatabaseMissing('category_user', ['user_id' => $agent->id]);
        $this->assertDatabaseHas('audit_logs', ['action' => 'user.categories_updated', 'actor_id' => $agent->id]);
    }

    public function test_other_agents_are_not_affected(): void
    {
        $agent = User::factory()->agent()->create();
        $colleague = User::factory()->agent()->create();
        $category = Category::factory()->create();
        $category->users()->attach($colleague->id);

        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => [$category->ulid]])->assertOk();
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => []])->assertOk();

        $this->assertSame([$colleague->id], $category->users()->pluck('users.id')->all());
        $this->actingAs($colleague, 'sanctum')->getJson('/api/v1/me/categories')->assertJsonPath('data.category_ulids', [$category->ulid]);
    }

    public function test_only_active_and_existing_categories_can_be_picked(): void
    {
        $agent = User::factory()->agent()->create();
        $inactive = Category::factory()->inactive()->create();
        $deleted = Category::factory()->create();
        $deleted->delete();
        $live = Category::factory()->create();

        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => [$live->ulid, $inactive->ulid, $deleted->ulid, '01hzzzzzzzzzzzzzzzzzzzzzzz']])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['category_ulids.1', 'category_ulids.2', 'category_ulids.3']]]);
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => [$live->ulid, $live->ulid]])->assertStatus(422);
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', [])->assertStatus(422);
        $this->actingAs($agent, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => 'x'])->assertStatus(422);

        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/me/categories')->assertJsonPath('data.category_ulids', []);
    }

    public function test_a_deactivated_category_disappears_from_the_selection(): void
    {
        $agent = User::factory()->agent()->create();
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);
        $category->delete();

        $this->actingAs($agent, 'sanctum')->getJson('/api/v1/me/categories')->assertJsonPath('data.category_ulids', []);
    }

    public function test_guests_and_admins_who_do_not_take_chats_are_turned_away(): void
    {
        $this->getJson('/api/v1/me/categories')->assertUnauthorized();
        $this->putJson('/api/v1/me/categories', ['category_ulids' => []])->assertUnauthorized();

        $adminOnly = User::factory()->admin()->create(['is_agent' => false]);
        $this->actingAs($adminOnly, 'sanctum')->getJson('/api/v1/me/categories')->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->actingAs($adminOnly, 'sanctum')->putJson('/api/v1/me/categories', ['category_ulids' => []])->assertForbidden();

        $adminAgent = User::factory()->admin()->create();
        $this->actingAs($adminAgent, 'sanctum')->getJson('/api/v1/me/categories')->assertOk();
    }
}
