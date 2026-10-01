<?php

namespace Tests\Feature\Chat;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Chat\Support\ConversationCategoryUsageChecker;
use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The real `category_in_use` guard (P3 shipped a stub that never blocked): a queued or active conversation keeps its
 * category from being deleted; finished ones do not.
 */
class CategoryUsageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    public function test_the_container_resolves_the_conversation_checker(): void
    {
        $this->assertInstanceOf(ConversationCategoryUsageChecker::class, app(CategoryUsageChecker::class));
    }

    /**
     * @return iterable<string, array{string, bool}>
     */
    public static function conversationStates(): iterable
    {
        yield 'queued live chat' => ['queued', true];
        yield 'active live chat' => ['active', true];
        yield 'queued offline ticket' => ['offline', true];
        yield 'ended chat' => ['ended', false];
        yield 'closed chat' => ['closed', false];
        yield 'missed chat' => ['missed', false];
    }

    #[DataProvider('conversationStates')]
    public function test_only_open_conversations_keep_a_category_alive(string $state, bool $inUse): void
    {
        $category = Category::factory()->create();
        $factory = Conversation::factory()->forCategory($category);
        match ($state) {
            'queued' => $factory->create(),
            'active' => $factory->active()->create(),
            'offline' => $factory->offline()->create(),
            'ended' => $factory->ended()->create(),
            'closed' => $factory->closed()->create(),
            'missed' => $factory->missed()->create(),
        };

        $this->assertSame($inUse, app(ConversationCategoryUsageChecker::class)->isInUse($category));
    }

    public function test_a_conversation_of_another_category_does_not_count(): void
    {
        $category = Category::factory()->create();
        Conversation::factory()->forCategory(Category::factory()->create())->create();
        Conversation::factory()->create();

        $this->assertFalse(app(ConversationCategoryUsageChecker::class)->isInUse($category));
    }

    public function test_deleting_a_category_through_the_api_is_refused_while_it_is_in_use_and_allowed_afterwards(): void
    {
        $this->useFortifyMode();
        $admin = User::factory()->admin()->create();
        $category = Category::factory()->create();
        $conversation = Conversation::factory()->forCategory($category)->create();

        $this->actingAs($admin, 'sanctum')->deleteJson('/api/v1/categories/'.$category->ulid)
            ->assertStatus(409)
            ->assertJsonPath('error.code', 'category_in_use');
        $this->assertNotSoftDeleted('categories', ['id' => $category->id]);

        $conversation->forceFill(['status' => 'closed'])->save();

        $this->actingAs($admin, 'sanctum')->deleteJson('/api/v1/categories/'.$category->ulid)->assertNoContent();
        $this->assertSoftDeleted('categories', ['id' => $category->id]);
        $this->assertSame($category->id, $conversation->fresh()?->category_id);
    }
}
