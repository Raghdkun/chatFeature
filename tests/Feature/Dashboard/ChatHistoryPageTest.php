<?php

namespace Tests\Feature\Dashboard;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\Message;
use App\Models\Rating;
use App\Models\User;
use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `GET /history` (admin only): filters and paging through the query string. */
class ChatHistoryPageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
        $this->admin = User::factory()->admin()->create();
    }

    /**
     * @param  array<string, string|int>  $query
     * @return list<string>
     */
    private function ulids(array $query = []): array
    {
        $props = $this->actingAs($this->admin)->get('/history?'.http_build_query($query))->assertOk()->viewData('page')['props'];

        return array_column($props['conversations'], 'ulid');
    }

    public function test_history_is_admin_only(): void
    {
        $this->get('/history')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->agent()->create())->get('/history')->assertForbidden();
        $this->actingAs(User::factory()->admin()->create())->get('/history')->assertOk()
            ->assertInertia(fn (Assert $page) => $page->component('history/index')->etc());
    }

    public function test_it_lists_every_conversation_newest_first_with_the_page_envelope(): void
    {
        $agent = User::factory()->agent()->create();
        $oldest = Conversation::factory()->closed($agent)->create(['created_at' => now()->subDays(3)]);
        $middle = Conversation::factory()->missed()->create(['created_at' => now()->subDays(2)]);
        $newest = Conversation::factory()->offline()->create(['created_at' => now()->subDay()]);

        $this->actingAs($this->admin)->get('/history')->assertInertia(fn (Assert $page) => $page
            ->has('conversations', 3)
            ->where('conversations.0.ulid', $newest->ulid)
            ->where('conversations.1.ulid', $middle->ulid)
            ->where('conversations.2.ulid', $oldest->ulid)
            ->where('pagination', ['page' => 1, 'perPage' => 25, 'total' => 3, 'lastPage' => 1, 'from' => 1, 'to' => 3])
            ->where('filters', ['status' => '', 'type' => '', 'category' => '', 'widget' => '', 'agent' => '', 'from' => '', 'to' => '', 'q' => ''])
            ->has('ratings', 0)
            ->has('filterOptions.categories')
            ->has('filterOptions.widgets')
            ->has('filterOptions.agents')
            ->etc());
    }

    public function test_it_pages_through_the_results(): void
    {
        Conversation::factory()->count(27)->create();

        $first = $this->ulids();
        $second = $this->ulids(['page' => 2]);

        $this->assertCount(25, $first);
        $this->assertCount(2, $second);
        $this->assertSame([], array_intersect($first, $second));

        $this->actingAs($this->admin)->get('/history?page=2')->assertInertia(fn (Assert $page) => $page
            ->where('pagination', ['page' => 2, 'perPage' => 25, 'total' => 27, 'lastPage' => 2, 'from' => 26, 'to' => 27])
            ->etc());
    }

    public function test_it_filters_by_status_and_type(): void
    {
        $closed = Conversation::factory()->closed()->create();
        $missed = Conversation::factory()->missed()->create();
        $ticket = Conversation::factory()->offline()->create();

        $this->assertSame([$closed->ulid], $this->ulids(['status' => 'closed']));
        $this->assertSame([$missed->ulid], $this->ulids(['status' => 'missed']));
        $this->assertSame([$ticket->ulid], $this->ulids(['type' => 'offline']));
        $this->assertSame([], $this->ulids(['type' => 'offline', 'status' => 'missed']));
    }

    public function test_it_filters_by_category_widget_and_agent(): void
    {
        $sales = Category::factory()->create(['name' => 'Sales']);
        $billing = Category::factory()->create(['name' => 'Billing']);
        $agent = User::factory()->agent()->create();
        $widget = Widget::factory()->create();

        $a = Conversation::factory()->forCategory($sales)->active($agent)->create();
        $b = Conversation::factory()->forCategory($billing)->create();
        $c = Conversation::factory()->for($widget)->create();

        $this->assertSame([$a->ulid], $this->ulids(['category' => $sales->ulid]));
        $this->assertSame([$b->ulid], $this->ulids(['category' => $billing->ulid]));
        $this->assertSame([$a->ulid], $this->ulids(['agent' => $agent->id]));
        $this->assertSame([$c->ulid], $this->ulids(['widget' => $widget->ulid]));
    }

    public function test_it_filters_by_a_date_range_inclusive_of_both_days(): void
    {
        $old = Conversation::factory()->create(['created_at' => '2026-03-01 08:00:00']);
        $first = Conversation::factory()->create(['created_at' => '2026-03-10 00:00:00']);
        $last = Conversation::factory()->create(['created_at' => '2026-03-12 23:59:00']);
        $late = Conversation::factory()->create(['created_at' => '2026-03-13 00:01:00']);

        $this->assertEqualsCanonicalizing([$first->ulid, $last->ulid], $this->ulids(['from' => '2026-03-10', 'to' => '2026-03-12']));
        $this->assertEqualsCanonicalizing([$late->ulid], $this->ulids(['from' => '2026-03-13']));
        $this->assertEqualsCanonicalizing([$old->ulid], $this->ulids(['to' => '2026-03-01']));
    }

    public function test_it_searches_ticket_visitor_and_message_text(): void
    {
        $byTicket = Conversation::factory()->create(['ticket_no' => 'ZZTOP9']);
        $byName = Conversation::factory()->for(Visitor::factory()->create(['name' => 'Zebediah Quill', 'email' => 'zq@example.com']))->create();
        $byMail = Conversation::factory()->for(Visitor::factory()->create(['name' => 'Someone', 'email' => 'findme@acme.test']))->create();
        $byText = Conversation::factory()->create();
        Message::factory()->for($byText)->create(['body' => 'My refund never arrived']);
        Conversation::factory()->create();

        $this->assertSame([$byTicket->ulid], $this->ulids(['q' => 'zztop9']));
        $this->assertSame([$byName->ulid], $this->ulids(['q' => 'Quill']));
        $this->assertSame([$byMail->ulid], $this->ulids(['q' => 'acme.test']));
        $this->assertSame([$byText->ulid], $this->ulids(['q' => 'refund']));
        $this->assertSame([], $this->ulids(['q' => 'no such thing']));
    }

    public function test_search_treats_like_wildcards_literally(): void
    {
        Conversation::factory()->count(2)->create();

        $this->assertSame([], $this->ulids(['q' => '%']));
        $this->assertSame([], $this->ulids(['q' => '_']));
    }

    public function test_bad_filter_values_are_ignored_instead_of_rejected(): void
    {
        Conversation::factory()->count(2)->create();

        $this->actingAs($this->admin)->get('/history?status=bogus&type=x&category=not-a-ulid&agent=12abc&from=2026-13-45&to=yesterday&page=abc')
            ->assertOk()
            ->assertInertia(fn (Assert $page) => $page
                ->has('conversations', 2)
                ->where('filters', ['status' => '', 'type' => '', 'category' => '', 'widget' => '', 'agent' => '', 'from' => '', 'to' => '', 'q' => ''])
                ->etc());
    }

    public function test_filters_are_echoed_back_and_survive_in_the_paging_links(): void
    {
        $this->actingAs($this->admin)->get('/history?status=closed&q=%20hello%20&from=2026-01-02')->assertInertia(fn (Assert $page) => $page
            ->where('filters.status', 'closed')
            ->where('filters.q', 'hello')
            ->where('filters.from', '2026-01-02')
            ->etc());
    }

    public function test_ratings_of_the_visible_page_come_with_it(): void
    {
        $rated = Conversation::factory()->closed()->create();
        $unrated = Conversation::factory()->closed()->create();
        Rating::factory()->score(4)->create(['conversation_id' => $rated->id, 'comment' => 'Helpful']);

        $this->actingAs($this->admin)->get('/history')->assertInertia(fn (Assert $page) => $page
            ->has('ratings', 1)
            ->where('ratings.0.conversation', $rated->ulid)
            ->where('ratings.0.score', 4)
            ->where('ratings.0.comment', 'Helpful')
            ->etc());

        $this->assertNotContains($unrated->ulid, array_column($this->actingAs($this->admin)->get('/history')->viewData('page')['props']['ratings'], 'conversation'));
    }

    public function test_the_filter_options_include_deleted_categories_and_widgets(): void
    {
        $gone = Category::factory()->create(['name' => 'Gone']);
        $gone->delete();
        $widget = Widget::factory()->create(['name' => 'Old widget']);
        $widget->delete();
        $agent = User::factory()->agent()->create(['name' => 'Ada']);
        User::factory()->withoutChatAccess()->create();

        $this->actingAs($this->admin)->get('/history')->assertInertia(fn (Assert $page) => $page
            ->where('filterOptions.categories.0.name', 'Gone')
            ->where('filterOptions.widgets.0.name', 'Old widget')
            ->where('filterOptions.agents', fn ($agents) => collect($agents)->contains(['id' => $agent->id, 'name' => 'Ada']))
            ->etc());
    }
}
