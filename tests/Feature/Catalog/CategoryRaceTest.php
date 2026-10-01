<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Actions\CreateCategory;
use App\Domain\Catalog\Actions\EnsureGeneralCategory;
use App\Domain\Catalog\Actions\SyncUserCategories;
use App\Models\Category;
use App\Models\User;
use Illuminate\Database\Connection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Check-then-insert races, staged deterministically: right before the statement of the request under test runs, a
 * competing request "commits" the row that statement would collide with (what a double click or two admins do).
 */
class CategoryRaceTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    /**
     * Run `$rival` once, right before the first statement that starts with `$statementPrefix`.
     *
     * @param  callable(Connection): void  $rival
     */
    private function raceBefore(string $statementPrefix, callable $rival): void
    {
        $fired = false;

        DB::beforeExecuting(function (string $query, array $bindings, Connection $connection) use ($statementPrefix, $rival, &$fired): void {
            if ($fired || ! str_starts_with($query, $statementPrefix)) {
                return;
            }

            $fired = true;
            $rival($connection);
        });
    }

    private function rivalCategory(Connection $connection, string $slug): void
    {
        $connection->table('categories')->insert([
            'ulid' => (string) Str::ulid(),
            'slug' => $slug,
            'name' => 'Rival '.$slug,
            'sort_order' => 0,
            'is_active' => true,
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_two_creates_that_pick_the_same_generated_slug_both_succeed(): void
    {
        $this->raceBefore('insert into "categories"', fn (Connection $connection) => $this->rivalCategory($connection, 'billing'));

        $category = app(CreateCategory::class)->handle(['name' => 'Billing']);

        $this->assertSame('billing-2', $category->slug, 'the loser asked the slugger again and got the next free slug');
        $this->assertSame(['billing', 'billing-2'], Category::query()->orderBy('slug')->pluck('slug')->all());
    }

    public function test_a_typed_slug_that_was_taken_in_the_meantime_is_a_clean_409(): void
    {
        $admin = User::factory()->admin()->create();
        $this->raceBefore('insert into "categories"', fn (Connection $connection) => $this->rivalCategory($connection, 'sales'));

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => 'Sales team', 'slug' => 'sales'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'slug_taken');

        $this->assertSame(['sales'], Category::query()->pluck('slug')->all(), 'only the rival exists');
    }

    public function test_changing_a_slug_to_one_taken_in_the_meantime_is_a_clean_409(): void
    {
        $admin = User::factory()->admin()->create();
        $category = Category::factory()->slug('old-slug')->create();
        $this->raceBefore('update "categories"', fn (Connection $connection) => $this->rivalCategory($connection, 'new-slug'));

        $this->actingAs($admin, 'sanctum')->patchJson('/api/v1/categories/'.$category->ulid, ['slug' => 'new-slug'])
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'slug_taken');

        $this->assertSame('old-slug', $category->fresh()?->slug);
    }

    public function test_the_general_category_seeder_survives_a_competing_seeder(): void
    {
        $this->raceBefore('insert into "categories"', fn (Connection $connection) => $this->rivalCategory($connection, EnsureGeneralCategory::SLUG));

        $category = app(EnsureGeneralCategory::class)->ensure();

        $this->assertSame(EnsureGeneralCategory::SLUG, $category->slug);
        $this->assertSame(1, Category::query()->count());
    }

    public function test_assigning_categories_survives_a_competing_assignment(): void
    {
        $agent = User::factory()->agent()->create();
        $category = Category::factory()->create();
        $this->raceBefore('insert into "category_user"', fn (Connection $connection) => $connection->table('category_user')->insert(['category_id' => $category->id, 'user_id' => $agent->id, 'created_at' => now(), 'updated_at' => now()]));

        $stored = app(SyncUserCategories::class)->handle($agent, [$category->ulid], $agent);

        $this->assertSame([$category->ulid], $stored);
        $this->assertSame(1, DB::table('category_user')->where('user_id', $agent->id)->count());
    }

    public function test_assigning_the_same_categories_twice_is_harmless(): void
    {
        $agent = User::factory()->agent()->create();
        [$a, $b] = [Category::factory()->create(), Category::factory()->create()];
        $action = app(SyncUserCategories::class);

        $action->handle($agent, [$a->ulid, $b->ulid], $agent);
        $action->handle($agent, [$a->ulid, $b->ulid], $agent);
        $action->handle($agent, [$b->ulid], $agent);

        $this->assertSame([$b->id], DB::table('category_user')->where('user_id', $agent->id)->pluck('category_id')->map(fn ($id): int => (int) $id)->all());
    }
}
