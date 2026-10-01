<?php

namespace Tests\Feature\Catalog;

use App\Models\Category;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\TestCase;

class CategoryPagesTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_the_categories_page_is_admin_only(): void
    {
        $this->get('/categories')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->agent()->create())->get('/categories')->assertForbidden();
        $this->actingAs(User::factory()->admin()->create())->get('/categories')->assertOk();
    }

    public function test_the_categories_page_props(): void
    {
        $category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing', 'name_i18n' => ['ar' => 'الفواتير'], 'sort_order' => 0]);
        $category->users()->attach(User::factory()->agent()->create()->id);
        $inactive = Category::factory()->inactive()->create(['sort_order' => 1]);

        $this->actingAs(User::factory()->admin()->create())->get('/categories')->assertInertia(fn (Assert $page) => $page
            ->component('categories/index')
            ->has('categories', 2)
            ->has('categories.0', fn (Assert $row) => $row
                ->where('ulid', $category->ulid)
                ->where('slug', 'billing')
                ->where('name', 'Billing')
                ->where('name_i18n.ar', 'الفواتير')
                ->where('agents_count', 1)
                ->where('widgets_count', 0)
                ->where('is_active', true)
                ->etc())
            ->where('categories.1.ulid', $inactive->ulid)
            ->where('categories.1.is_active', false)
            ->etc());
    }

    public function test_the_support_categories_page_is_open_to_every_staff_member(): void
    {
        $this->get('/settings/support-categories')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->withoutChatAccess()->create())->get('/settings/support-categories')->assertRedirect(route('login'));
        $this->flushSession();
        $this->actingAs(User::factory()->agent()->create())->get('/settings/support-categories')->assertOk();
        $this->actingAs(User::factory()->admin()->create())->get('/settings/support-categories')->assertOk();
    }

    public function test_the_support_categories_page_props(): void
    {
        $agent = User::factory()->agent()->create();
        $billing = Category::factory()->create(['sort_order' => 0]);
        $sales = Category::factory()->create(['sort_order' => 1]);
        Category::factory()->inactive()->create();
        $deleted = Category::factory()->create();
        $deleted->users()->attach($agent->id);
        $deleted->delete();
        $sales->users()->attach($agent->id);
        $billing->users()->attach(User::factory()->agent()->create()->id);

        $this->actingAs($agent)->get('/settings/support-categories')->assertInertia(fn (Assert $page) => $page
            ->component('settings/support-categories')
            ->has('categories', 2, fn (Assert $row) => $row->has('ulid')->has('slug')->has('name')->etc())
            ->where('categories.0.ulid', $billing->ulid)
            ->where('categories.1.ulid', $sales->ulid)
            ->where('selected', [$sales->ulid])
            ->etc());
    }
}
