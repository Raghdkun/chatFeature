<?php

namespace Tests\Feature\Analytics;

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/** `GET /analytics` (Inertia): a shell with the viewer's scope and filters; the numbers come from the API. */
class AnalyticsPageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->useFortifyMode();
        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_it_needs_a_signed_in_member_of_staff(): void
    {
        $this->get('/analytics')->assertRedirect(route('login'));
        // An account without a chat role is signed out by the web stack (`no_chat_access`), like on every dashboard page.
        $this->actingAs(User::factory()->withoutChatAccess()->create())->get('/analytics')->assertRedirect(route('login'));
        $this->actingAs(User::factory()->admin()->create())->get('/analytics')->assertOk()
            ->assertInertia(fn (Assert $page) => $page->component('analytics/index')->etc());
        $this->actingAs(User::factory()->agent()->create())->get('/analytics')->assertOk();
    }

    public function test_an_administrator_gets_the_scope_the_defaults_and_the_filter_menus(): void
    {
        $admin = User::factory()->admin()->create();
        $widget = Widget::factory()->create(['name' => 'Main site']);
        $gone = Widget::factory()->create(['name' => 'Old shop']);
        $gone->delete();
        $category = Category::factory()->create(['name' => 'Billing']);
        $agent = User::factory()->agent()->create(['name' => 'Ann']);
        User::factory()->withoutChatAccess()->create(['name' => 'Not staff']);

        $this->actingAs($admin)->get('/analytics')->assertInertia(fn (Assert $page) => $page
            ->where('scope', ['role' => 'admin', 'userId' => $admin->id, 'whatsapp' => true])
            ->where('timezone', 'UTC')
            ->where('today', now()->format('Y-m-d'))
            ->where('filters', ['from' => now()->subDays(29)->format('Y-m-d'), 'to' => now()->format('Y-m-d'), 'widget' => null, 'category' => null, 'agent' => null, 'compare' => true])
            ->where('options.widgets', [['key' => $widget->ulid, 'label' => 'Main site', 'deleted' => false], ['key' => $gone->ulid, 'label' => 'Old shop', 'deleted' => true]])
            ->where('options.categories', [['key' => $category->ulid, 'label' => 'Billing', 'deleted' => false]])
            ->has('options.agents', 2)
            ->where('options.agents.0.label', 'Ann')
            ->where('options.agents.0.key', (string) $agent->id));
    }

    public function test_the_filters_of_the_link_are_kept_and_nonsense_is_dropped(): void
    {
        $admin = User::factory()->admin()->create();
        $widget = Widget::factory()->create();

        $this->actingAs($admin)->get('/analytics?from=2026-03-01&to=2026-03-31&compare=0&widget='.$widget->ulid)->assertInertia(fn (Assert $page) => $page
            ->where('filters', ['from' => '2026-03-01', 'to' => '2026-03-31', 'widget' => $widget->ulid, 'category' => null, 'agent' => null, 'compare' => false]));

        // A stale or hand-edited link still opens: bad dates fall back, a second filter is dropped, an unknown shape is ignored.
        $this->actingAs($admin)->get('/analytics?from=2026-02-31&to=nope&widget=x&category='.str_repeat('A', 26).'&agent=3')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->where('filters.from', now()->subDays(29)->format('Y-m-d'))
            ->where('filters.to', now()->format('Y-m-d'))
            ->where('filters.widget', null)
            ->where('filters.category', str_repeat('A', 26))
            ->where('filters.agent', null));
        $this->actingAs($admin)->get('/analytics?from=2026-03-31&to=2026-03-01')->assertInertia(fn (Assert $page) => $page->where('filters.to', '2026-03-01')->where('filters.from', '2026-01-31'));
        $this->actingAs($admin)->get('/analytics?to=2099-01-01')->assertInertia(fn (Assert $page) => $page->where('filters.to', now()->format('Y-m-d')));
    }

    public function test_an_agent_gets_only_their_own_view_with_no_menus_and_no_filters(): void
    {
        $agent = User::factory()->agent()->create();
        $widget = Widget::factory()->create();
        Category::factory()->create();

        $this->actingAs($agent)->get('/analytics?widget='.$widget->ulid.'&agent=99&from=2026-03-01&to=2026-03-31')->assertInertia(fn (Assert $page) => $page
            ->where('scope', ['role' => 'agent', 'userId' => $agent->id, 'whatsapp' => false])
            ->where('filters', ['from' => '2026-03-01', 'to' => '2026-03-31', 'widget' => null, 'category' => null, 'agent' => null, 'compare' => true])
            ->where('options', ['widgets' => [], 'categories' => [], 'agents' => []]));
    }

    public function test_the_page_never_carries_a_number(): void
    {
        $this->actingAs(User::factory()->admin()->create())->get('/analytics')->assertInertia(fn (Assert $page) => $page
            ->missing('overview')->missing('current')->missing('kpis'));
    }
}
