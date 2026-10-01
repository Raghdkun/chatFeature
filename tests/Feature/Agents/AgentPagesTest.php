<?php

namespace Tests\Feature\Agents;

use App\Models\Category;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class AgentPagesTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_the_agents_page_is_admin_only(): void
    {
        $this->get('/agents')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->agent()->create())->get('/agents')->assertForbidden();
        $this->actingAs(User::factory()->admin()->create())->get('/agents')->assertOk();
    }

    public function test_the_agents_page_props_in_mode_one(): void
    {
        $admin = User::factory()->admin()->create(['name' => 'Ada']);
        $agent = User::factory()->agent()->create(['name' => 'Bob']);
        User::factory()->withoutChatAccess()->create(['name' => 'Nobody']);
        $category = Category::factory()->create();
        $category->users()->attach($agent->id);

        $this->actingAs($admin)->get('/agents')->assertInertia(fn (Assert $page) => $page
            ->component('agents/index')
            ->where('authMode', 'fortify')
            ->where('canManageStaff', true)
            ->has('agents', 2)
            ->where('agents.0.id', $admin->id)
            ->where('agents.0.is_admin', true)
            ->where('agents.1.id', $agent->id)
            ->where('agents.1.category_ulids', [$category->ulid])
            ->where('agents.1.auth_source', 'local')
            ->has('categories', 1, fn (Assert $row) => $row->where('ulid', $category->ulid)->where('agents_count', 1)->etc())
            ->etc());
    }

    public function test_staff_cannot_be_managed_in_pizzasys_mode(): void
    {
        $this->usePizzasysMode();

        $this->actingAs(User::factory()->admin()->create())->get('/agents')->assertInertia(fn (Assert $page) => $page
            ->where('authMode', 'pizzasys')
            ->where('canManageStaff', false)
            ->etc());
    }
}
