<?php

namespace Tests\Feature\Widgets;

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Inertia\Testing\AssertableInertia as Assert;
use Tests\Support\AssertsPublicPayloads;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Inertia pages `widgets/index` and `widgets/builder` (props: docs/contracts/dashboard-pages-p3.md).
 */
class WidgetPagesTest extends TestCase
{
    use AssertsPublicPayloads, RefreshDatabase, WidgetFixtures;

    protected function setUp(): void
    {
        parent::setUp();

        $this->withoutVite();
        config(['inertia.testing.ensure_pages_exist' => false]);
    }

    public function test_guests_are_sent_to_the_login_page(): void
    {
        $widget = Widget::factory()->create();

        $this->get('/widgets')->assertRedirect(route('login'));
        $this->get('/widgets/'.$widget->ulid)->assertRedirect(route('login'));
    }

    public function test_agents_are_forbidden(): void
    {
        $widget = Widget::factory()->create();
        $agent = User::factory()->agent()->create();

        $this->actingAs($agent)->get('/widgets')->assertForbidden();
        $this->actingAs($agent)->get('/widgets/'.$widget->ulid)->assertForbidden();
    }

    public function test_admins_can_open_both_pages(): void
    {
        $widget = Widget::factory()->create();
        $admin = User::factory()->admin()->create();

        $this->actingAs($admin)->get('/widgets')->assertOk();
        $this->actingAs($admin)->get('/widgets/'.$widget->ulid)->assertOk();
    }

    public function test_the_widget_list_props(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['a.test', 'b.test'])->create(['name' => 'Alpha', 'config_version' => 4]);
        $widget->categories()->attach(Category::factory()->create()->id, ['sort_order' => 0]);

        $this->actingAs(User::factory()->admin()->create())->get('/widgets')->assertInertia(fn (Assert $page) => $page
            ->component('widgets/index')
            ->has('widgets', 1, fn (Assert $row) => $row
                ->where('ulid', $widget->ulid)
                ->where('name', 'Alpha')
                ->where('public_key', $widget->public_key)
                ->where('is_enabled', true)
                ->where('config_version', 4)
                ->where('has_unpublished_changes', false)
                ->where('whatsapp_connected', false)
                ->where('domains_count', 2)
                ->where('categories_count', 1)
                ->has('updated_at'))
            ->etc());
    }

    public function test_the_builder_props(): void
    {
        $widget = Widget::factory()->enabled()->withDomains(['customer.test', '*.shop.test'])->withIdentitySecret('super-secret-value')->create(['name' => 'Main']);
        [$first, $second] = Category::factory()->count(2)->create()->all();
        $widget->categories()->attach([$second->id => ['sort_order' => 0], $first->id => ['sort_order' => 1]]);
        $widget->greetings()->create(['body' => 'Hello', 'agent_name' => 'Sara', 'weight' => 3, 'sort_order' => 0]);

        $draft = $widget->draft_config;
        $draft['theme']['primary'] = '#112233';
        $widget->forceFill(['draft_config' => $draft])->save();

        $response = $this->actingAs(User::factory()->admin()->create())->get('/widgets/'.$widget->ulid);

        $response->assertOk()->assertInertia(fn (Assert $page) => $page
            ->component('widgets/builder')
            ->where('widget.ulid', $widget->ulid)
            ->where('widget.has_identity_secret', true)
            ->where('widget.has_unpublished_changes', true)
            ->where('config.theme.primary', '#0f766e')
            ->where('draft_config.theme.primary', '#112233')
            ->where('config.v', 1)
            ->has('config.routing.waves', 2)
            ->has('config.texts.en.title')
            ->where('domains', ['*.shop.test', 'customer.test'])
            ->where('category_ulids', [$second->ulid, $first->ulid])
            ->has('all_categories', 2)
            ->has('greetings', 1, fn (Assert $greeting) => $greeting->where('body', 'Hello')->where('agent_name', 'Sara')->where('weight', 3)->etc())
            ->has('snippets', fn (Assert $snippets) => $snippets->has('script')->has('iframe')->has('hosted')->has('identity_example.php')->has('identity_example.node')->has('identity_example.python'))
            ->where('preview.embed_url', rtrim((string) config('app.url'), '/').'/embed/'.$widget->public_key.'?preview=1')
            ->where('preview.app_origin', rtrim((string) config('app.url'), '/'))
            ->etc());

        $props = $response->viewData('page')['props'];
        $this->assertSame(
            ['widget', 'config', 'draft_config', 'greetings', 'domains', 'category_ulids', 'all_categories', 'snippets', 'preview'],
            array_values(array_intersect(['widget', 'config', 'draft_config', 'greetings', 'domains', 'category_ulids', 'all_categories', 'snippets', 'preview'], array_keys($props))),
        );
        $this->assertNoIntegerIds(array_diff_key($props, ['auth' => 1]));
        $this->assertStringNotContainsString('super-secret-value', (string) json_encode($props));
        $this->assertStringNotContainsString('identity_secret_encrypted', (string) json_encode($props));
    }

    public function test_the_builder_lists_every_category_with_counts(): void
    {
        $widget = Widget::factory()->create();
        $active = Category::factory()->create(['sort_order' => 0]);
        $inactive = Category::factory()->inactive()->create(['sort_order' => 1]);
        $active->users()->attach(User::factory()->agent()->create()->id);
        $active->widgets()->attach($widget->id, ['sort_order' => 0]);

        $this->actingAs(User::factory()->admin()->create())->get('/widgets/'.$widget->ulid)->assertInertia(fn (Assert $page) => $page
            ->has('all_categories', 2)
            ->where('all_categories.0.ulid', $active->ulid)
            ->where('all_categories.0.agents_count', 1)
            ->where('all_categories.0.widgets_count', 1)
            ->where('all_categories.1.ulid', $inactive->ulid)
            ->where('all_categories.1.is_active', false)
            ->etc());
    }

    public function test_unknown_and_deleted_widgets_are_404(): void
    {
        $admin = User::factory()->admin()->create();
        $widget = Widget::factory()->create();

        $this->actingAs($admin)->get('/widgets/01hzzzzzzzzzzzzzzzzzzzzzzz')->assertNotFound();
        $this->actingAs($admin)->get('/widgets/'.$widget->id)->assertNotFound();

        $widget->delete();
        $this->actingAs($admin)->get('/widgets/'.$widget->ulid)->assertNotFound();
    }
}
