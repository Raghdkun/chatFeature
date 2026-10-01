<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Catalog\Support\NullCategoryUsageChecker;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

class CategoryApiTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()->admin()->create();
    }

    private function asAdmin(): static
    {
        return $this->actingAs($this->admin, 'sanctum');
    }

    // ---- authorization -----------------------------------------------------------------------------------------

    public function test_listing_is_open_to_every_staff_member_but_not_to_guests(): void
    {
        $this->getJson('/api/v1/categories')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
        $this->actingAs(User::factory()->withoutChatAccess()->create(), 'sanctum')->getJson('/api/v1/categories')->assertForbidden();
        $this->actingAs(User::factory()->agent()->create(), 'sanctum')->getJson('/api/v1/categories')->assertOk();
        $this->asAdmin()->getJson('/api/v1/categories')->assertOk();
    }

    /**
     * @return array<string, array{0: string, 1: string, 2: array<string, mixed>}>
     */
    public static function adminEndpoints(): array
    {
        return [
            'create' => ['POST', '/api/v1/categories', ['name' => 'Sales']],
            'show' => ['GET', '/api/v1/categories/{ulid}', []],
            'update' => ['PATCH', '/api/v1/categories/{ulid}', ['name' => 'Renamed']],
            'delete' => ['DELETE', '/api/v1/categories/{ulid}', []],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('adminEndpoints')]
    public function test_writes_are_admin_only(string $method, string $uri, array $body): void
    {
        $uri = str_replace('{ulid}', Category::factory()->create()->ulid, $uri);

        $this->json($method, $uri, $body)->assertUnauthorized();
        $this->actingAs(User::factory()->agent()->create(), 'sanctum')->json($method, $uri, $body)->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->assertContains($this->asAdmin()->json($method, $uri, $body)->status(), [200, 201, 204]);
    }

    // ---- create ------------------------------------------------------------------------------------------------

    public function test_creating_a_category_generates_its_slug(): void
    {
        $response = $this->asAdmin()->postJson('/api/v1/categories', [
            'name' => 'Billing & Payments',
            'description' => 'Invoices, refunds and cards',
            'icon' => 'credit-card',
            'color' => '#0f766e',
            'name_i18n' => ['ar' => 'الفواتير', 'de' => 'Abrechnung'],
        ]);

        $response->assertCreated()
            ->assertJsonPath('data.slug', 'billing-payments')
            ->assertJsonPath('data.name', 'Billing & Payments')
            ->assertJsonPath('data.description', 'Invoices, refunds and cards')
            ->assertJsonPath('data.icon', 'credit-card')
            ->assertJsonPath('data.color', '#0f766e')
            ->assertJsonPath('data.name_i18n.ar', 'الفواتير')
            ->assertJsonPath('data.is_active', true)
            ->assertJsonPath('data.agents_count', 0)
            ->assertJsonPath('data.widgets_count', 0);

        $data = $response->json('data');
        $this->assertMatchesRegularExpression('/^[0-9a-z]{26}$/', $data['ulid']);
        $this->assertSame(['ulid', 'slug', 'name', 'name_i18n', 'description', 'icon', 'color', 'sort_order', 'is_active', 'agents_count', 'widgets_count'], array_keys($data));
        $this->assertNoIntegerIds($data);
        $this->assertDatabaseHas('audit_logs', ['action' => 'category.created', 'actor_id' => $this->admin->id]);
    }

    public function test_translations_serialise_as_an_object_even_when_empty(): void
    {
        $response = $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Plain'])->assertCreated();

        $this->assertStringContainsString('"name_i18n":{}', (string) $response->getContent());
        $this->assertStringContainsString('"name_i18n":{}', (string) $this->asAdmin()->getJson('/api/v1/categories')->getContent());
    }

    public function test_slugs_are_unique_and_suffixed_when_generated(): void
    {
        $slugs = collect(['Billing', 'billing', 'BILLING!'])->map(fn (string $name): string => $this->asAdmin()->postJson('/api/v1/categories', ['name' => $name])->json('data.slug'));

        $this->assertSame(['billing', 'billing-2', 'billing-3'], $slugs->all());
    }

    public function test_a_name_without_letters_still_gets_a_slug(): void
    {
        $this->assertSame('category', $this->asAdmin()->postJson('/api/v1/categories', ['name' => '???'])->json('data.slug'));
        $this->assertSame('category-2', $this->asAdmin()->postJson('/api/v1/categories', ['name' => '!!!'])->json('data.slug'));
    }

    public function test_an_explicit_slug_is_used_and_must_be_unique(): void
    {
        $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Sales', 'slug' => 'sales-team'])->assertCreated()->assertJsonPath('data.slug', 'sales-team');

        $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Other', 'slug' => 'sales-team'])
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => ['slug']]]);
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidCategories(): array
    {
        return [
            'name missing' => [[], 'name'],
            'name empty' => [['name' => ''], 'name'],
            'name too long' => [['name' => str_repeat('x', 121)], 'name'],
            'slug upper case' => [['name' => 'X', 'slug' => 'Sales'], 'slug'],
            'slug with spaces' => [['name' => 'X', 'slug' => 'sales team'], 'slug'],
            'slug with underscore' => [['name' => 'X', 'slug' => 'sales_team'], 'slug'],
            'slug leading hyphen' => [['name' => 'X', 'slug' => '-sales'], 'slug'],
            'slug double hyphen' => [['name' => 'X', 'slug' => 'sales--team'], 'slug'],
            'slug too long' => [['name' => 'X', 'slug' => str_repeat('a', 65)], 'slug'],
            'color name' => [['name' => 'X', 'color' => 'teal'], 'color'],
            'color five digits' => [['name' => 'X', 'color' => '#12345'], 'color'],
            'icon with markup' => [['name' => 'X', 'icon' => '<img src=x>'], 'icon'],
            'icon too long' => [['name' => 'X', 'icon' => str_repeat('a', 65)], 'icon'],
            'description too long' => [['name' => 'X', 'description' => str_repeat('a', 1001)], 'description'],
            'sort order negative' => [['name' => 'X', 'sort_order' => -1], 'sort_order'],
            'is_active not boolean' => [['name' => 'X', 'is_active' => 'perhaps'], 'is_active'],
            'translations not an object' => [['name' => 'X', 'name_i18n' => 'ar'], 'name_i18n'],
            'translation locale invalid' => [['name' => 'X', 'name_i18n' => ['not a locale' => 'x']], 'name_i18n.not a locale'],
            'translation too long' => [['name' => 'X', 'name_i18n' => ['ar' => str_repeat('x', 121)]], 'name_i18n.ar'],
        ];
    }

    /**
     * @param  array<string, mixed>  $body
     */
    #[DataProvider('invalidCategories')]
    public function test_invalid_categories_are_rejected(array $body, string $field): void
    {
        $this->asAdmin()->postJson('/api/v1/categories', $body)
            ->assertStatus(422)
            ->assertJsonPath('error.code', 'validation_failed')
            ->assertJsonStructure(['error' => ['details' => [$field]]]);
        $this->assertSame(0, Category::query()->count());
    }

    public function test_new_categories_are_sorted_last(): void
    {
        Category::factory()->create(['sort_order' => 4]);

        $this->assertSame(5, $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Late'])->json('data.sort_order'));
        $this->assertSame(2, $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Early', 'sort_order' => 2])->json('data.sort_order'));
    }

    // ---- read --------------------------------------------------------------------------------------------------

    public function test_listing_shows_counts_and_orders_by_sort_order(): void
    {
        $first = Category::factory()->create(['name' => 'Alpha', 'sort_order' => 1]);
        $second = Category::factory()->create(['name' => 'Beta', 'sort_order' => 0]);
        $inactive = Category::factory()->inactive()->create(['name' => 'Gamma', 'sort_order' => 2]);

        $first->users()->attach([User::factory()->agent()->create()->id, User::factory()->agent()->create()->id, User::factory()->agent()->inactive()->create()->id]);
        $first->widgets()->attach(Widget::factory()->create()->id, ['sort_order' => 0]);

        $response = $this->asAdmin()->getJson('/api/v1/categories')->assertOk()->assertJsonPath('meta.next_cursor', null);

        $this->assertSame([$second->ulid, $first->ulid, $inactive->ulid], array_column($response->json('data'), 'ulid'));
        $this->assertSame(2, $response->json('data.1.agents_count'), 'only active staff are counted');
        $this->assertSame(1, $response->json('data.1.widgets_count'));
        $this->assertNoIntegerIds($response->json());
    }

    public function test_agents_only_see_active_categories(): void
    {
        $active = Category::factory()->create();
        Category::factory()->inactive()->create();

        $response = $this->actingAs(User::factory()->agent()->create(), 'sanctum')->getJson('/api/v1/categories')->assertOk();

        $this->assertSame([$active->ulid], array_column($response->json('data'), 'ulid'));
    }

    public function test_showing_a_category(): void
    {
        $category = Category::factory()->create();

        $this->asAdmin()->getJson('/api/v1/categories/'.$category->ulid)->assertOk()->assertJsonPath('data.slug', $category->slug);
        $this->asAdmin()->getJson('/api/v1/categories/'.$category->id)->assertNotFound();
        $this->asAdmin()->getJson('/api/v1/categories/01hzzzzzzzzzzzzzzzzzzzzzzz')->assertNotFound();
    }

    // ---- update ------------------------------------------------------------------------------------------------

    public function test_updating_a_category_partially(): void
    {
        $category = Category::factory()->create(['name' => 'Old', 'slug' => 'old', 'is_active' => true]);

        $this->asAdmin()->patchJson('/api/v1/categories/'.$category->ulid, ['name' => 'New', 'is_active' => false, 'color' => null])
            ->assertOk()
            ->assertJsonPath('data.name', 'New')
            ->assertJsonPath('data.is_active', false)
            ->assertJsonPath('data.slug', 'old', 'the slug does not follow the name');

        $this->assertDatabaseHas('audit_logs', ['action' => 'category.updated', 'subject_id' => (string) $category->id]);
    }

    public function test_a_category_may_keep_its_own_slug_but_not_take_anothers(): void
    {
        $one = Category::factory()->create(['slug' => 'one']);
        Category::factory()->create(['slug' => 'two']);

        $this->asAdmin()->patchJson('/api/v1/categories/'.$one->ulid, ['slug' => 'one', 'name' => 'Uno'])->assertOk();
        $this->asAdmin()->patchJson('/api/v1/categories/'.$one->ulid, ['slug' => 'two'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['slug']]]);
        $this->asAdmin()->patchJson('/api/v1/categories/'.$one->ulid, ['slug' => 'uno'])->assertOk()->assertJsonPath('data.slug', 'uno');
        $this->asAdmin()->patchJson('/api/v1/categories/'.$one->ulid, ['name' => ''])->assertStatus(422);
    }

    public function test_changes_reach_widgets_that_offer_the_category_at_once(): void
    {
        $category = Category::factory()->create(['slug' => 'billing', 'name' => 'Billing']);
        $widget = $this->enabledWidget(['customer.test'], [], $category);
        $url = '/api/v1/public/widgets/'.$widget->public_key.'/config';
        $headers = ['Origin' => 'https://customer.test'];

        $this->withHeaders($headers)->getJson($url)->assertJsonPath('data.categories.0.label', 'Billing');

        $this->asAdmin()->patchJson('/api/v1/categories/'.$category->ulid, ['name' => 'Payments', 'slug' => 'payments'])->assertOk();
        $this->withHeaders($headers)->getJson($url)->assertJsonPath('data.categories.0.label', 'Payments')->assertJsonPath('data.categories.0.slug', 'payments');

        $this->asAdmin()->patchJson('/api/v1/categories/'.$category->ulid, ['is_active' => false])->assertOk();
        $this->withHeaders($headers)->getJson($url)->assertJsonCount(0, 'data.categories');
    }

    // ---- delete ------------------------------------------------------------------------------------------------

    public function test_deleting_is_soft_and_frees_the_slug_and_the_links(): void
    {
        $category = Category::factory()->create(['slug' => 'billing']);
        $agent = User::factory()->agent()->create();
        $category->users()->attach($agent->id);
        $widget = $this->enabledWidget(['customer.test'], [], $category);

        $this->asAdmin()->deleteJson('/api/v1/categories/'.$category->ulid)->assertNoContent();

        $this->assertSoftDeleted('categories', ['id' => $category->id]);
        $this->assertDatabaseMissing('category_user', ['category_id' => $category->id]);
        $this->assertDatabaseMissing('widget_category', ['category_id' => $category->id]);
        $this->asAdmin()->getJson('/api/v1/categories/'.$category->ulid)->assertNotFound();
        $this->asAdmin()->getJson('/api/v1/categories')->assertJsonCount(0, 'data');
        $this->withHeaders(['Origin' => 'https://customer.test'])->getJson('/api/v1/public/widgets/'.$widget->public_key.'/config')->assertJsonCount(0, 'data.categories');
        $this->assertDatabaseHas('audit_logs', ['action' => 'category.deleted']);

        // The slug is free again.
        $this->asAdmin()->postJson('/api/v1/categories', ['name' => 'Billing', 'slug' => 'billing'])->assertCreated()->assertJsonPath('data.slug', 'billing');
        $this->assertSame(2, Category::withTrashed()->where('slug', 'like', 'billing%')->count());
    }

    public function test_deleting_is_refused_while_a_conversation_uses_the_category(): void
    {
        $this->app->instance(CategoryUsageChecker::class, new class implements CategoryUsageChecker
        {
            public function isInUse(Category $category): bool
            {
                return true;
            }
        });
        $category = Category::factory()->create();

        $this->asAdmin()->deleteJson('/api/v1/categories/'.$category->ulid)
            ->assertStatus(409)
            ->assertExactJson(['error' => ['code' => 'category_in_use', 'message' => 'This category is used by an active conversation and cannot be deleted yet.']]);

        $this->assertNotSoftDeleted('categories', ['id' => $category->id]);
    }

    public function test_the_default_usage_checker_never_blocks(): void
    {
        $this->assertInstanceOf(NullCategoryUsageChecker::class, app(CategoryUsageChecker::class));
    }
}
