<?php

namespace Tests\Feature\Catalog;

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** Names an administrator types cannot carry bidirectional overrides or line breaks (visitors' names and messages never could). */
class DisplayTextCleaningTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private const HOSTILE = "Bill\u{202E}gnil\u{202C}\nPayments\u{2066}";

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
    }

    public function test_a_category_name_and_description_are_one_clean_line(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => self::HOSTILE, 'description' => self::HOSTILE])->assertCreated();

        $category = Category::query()->latest('id')->firstOrFail();
        $this->assertSame('Bill gnil Payments', $category->name);
        $this->assertSame('Bill gnil Payments', $category->description);
    }

    public function test_a_widget_name_and_a_new_staff_name_are_cleaned(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/widgets', ['name' => self::HOSTILE])->assertCreated();
        $this->assertSame('Bill gnil Payments', Widget::query()->latest('id')->firstOrFail()->name);

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/agents', ['name' => self::HOSTILE, 'email' => 'new.agent@example.test', 'password' => 'A-strong-pass-2026!'])->assertCreated();
        $this->assertSame('Bill gnil Payments', User::query()->where('email', 'new.agent@example.test')->firstOrFail()->name);
    }

    public function test_a_name_made_only_of_hidden_characters_is_refused(): void
    {
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => "\u{202E}\u{2066} \n"])->assertStatus(422);
    }

    public function test_two_topics_cannot_share_a_name_but_a_deleted_one_frees_it(): void
    {
        $admin = User::factory()->admin()->create();
        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => 'Billing'])->assertCreated();

        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => 'Billing'])->assertStatus(422)->assertJsonValidationErrors('name', 'error.details');

        Category::query()->where('name', 'Billing')->firstOrFail()->delete();
        $this->actingAs($admin, 'sanctum')->postJson('/api/v1/categories', ['name' => 'Billing'])->assertCreated();
    }
}
