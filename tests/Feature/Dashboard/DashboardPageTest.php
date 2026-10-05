<?php

namespace Tests\Feature\Dashboard;

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * The dashboard's setup checklist and "can chats reach me" status come from the real configuration, not from placeholders.
 */
class DashboardPageTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_guests_are_sent_to_the_login_page(): void
    {
        $this->get('/dashboard')->assertRedirect(route('login'));
    }

    public function test_the_page_title_carries_the_name_chosen_in_the_wizard(): void
    {
        $this->useFortifyMode();
        settings()->set('app.name', 'Acme Support');

        $this->get('/login')->assertOk()->assertSeeInOrder(['<title', 'Acme Support', '</title>'], false);
    }

    public function test_an_empty_installation_shows_every_step_still_to_do(): void
    {
        $admin = User::factory()->admin()->create(['is_agent' => true]);

        $this->actingAs($admin)->get('/dashboard')->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('dashboard')
            ->where('setup.categories', 0)
            ->where('setup.widgets', 0)
            ->where('setup.widgetUlid', null)
            ->where('setup.widgetsLive', 0)
            ->where('setup.widgetsReachable', 0)
            ->where('setup.widgetCustomised', false)
            ->where('setup.agentsServing', 0)
            ->where('serving.takesChats', true)
            ->where('serving.categories', 0));
    }

    public function test_the_checklist_follows_what_the_administrator_configured(): void
    {
        $admin = User::factory()->admin()->create(['is_agent' => true]);
        $category = Category::factory()->create();
        $admin->categories()->attach($category->id);
        $widget = Widget::factory()->enabled()->withDomains(['customer.example'])->create(['config_version' => 2]);
        Widget::factory()->create(['is_enabled' => false]);

        $this->actingAs($admin)->get('/dashboard')->assertInertia(fn (Assert $page) => $page
            ->where('setup.categories', 1)
            ->where('setup.widgets', 2)
            ->where('setup.widgetUlid', $widget->ulid)
            ->where('setup.widgetsLive', 1)
            ->where('setup.widgetsReachable', 1)
            ->where('setup.widgetCustomised', true)
            ->where('setup.agentsServing', 1)
            ->where('serving.categories', 1));
    }

    public function test_a_live_widget_without_a_domain_is_not_reachable_and_an_inactive_category_does_not_count(): void
    {
        $admin = User::factory()->admin()->create(['is_agent' => true]);
        $inactive = Category::factory()->create(['is_active' => false]);
        $admin->categories()->attach($inactive->id);
        Widget::factory()->enabled()->create();

        $this->actingAs($admin)->get('/dashboard')->assertInertia(fn (Assert $page) => $page
            ->where('setup.widgetsLive', 1)
            ->where('setup.widgetsReachable', 0)
            ->where('setup.categories', 0)
            ->where('setup.agentsServing', 0)
            ->where('serving.categories', 0));
    }

    public function test_an_agent_gets_no_setup_data_but_learns_whether_chats_can_reach_them(): void
    {
        Widget::factory()->enabled()->withDomains(['customer.example'])->create();
        $agent = User::factory()->agent()->create();

        $this->actingAs($agent)->get('/dashboard')->assertInertia(fn (Assert $page) => $page
            ->where('setup', null)
            ->where('serving.takesChats', true)
            ->where('serving.categories', 0));
    }

    public function test_an_administrator_who_does_not_take_chats_is_not_nagged_about_categories(): void
    {
        $admin = User::factory()->admin()->create(['is_agent' => false]);

        $this->actingAs($admin)->get('/dashboard')->assertInertia(fn (Assert $page) => $page
            ->where('serving.takesChats', false));
    }
}
