<?php

namespace Tests\Feature\Install;

use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use App\Models\WidgetGreeting;

/**
 * The wizard's seed-defaults step also creates the "General" category and one DISABLED sample widget
 * (install seeders of the Catalog and Widgets contexts).
 */
class SampleDataSeedingTest extends InstallTestCase
{
    private function install(): void
    {
        $this->answerWizard();
        $this->postJson(route('setup.run', 'run-migrations'))->assertJsonPath('status', 'ok');
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');
    }

    public function test_a_fresh_install_gets_a_general_category_and_a_disabled_sample_widget(): void
    {
        $this->install();

        $category = Category::query()->where('slug', 'general')->firstOrFail();
        $this->assertSame('General', $category->name);
        $this->assertTrue($category->is_active);

        $widget = Widget::query()->firstOrFail();
        $this->assertSame('Sample widget', $widget->name);
        $this->assertFalse($widget->is_enabled, 'the sample is disabled until an admin turns it on');
        $this->assertMatchesRegularExpression('/^wk_[a-z0-9]{20}$/', $widget->public_key);
        $this->assertSame(1, $widget->config_version);
        $this->assertSame($widget->config, $widget->draft_config);
        $this->assertSame('#0f766e', $widget->config['theme']['primary']);
        $this->assertNull($widget->identity_secret_encrypted);
        $this->assertSame([$category->ulid], $widget->categories()->pluck('ulid')->all());

        $greetings = $widget->greetings()->get();
        $this->assertCount(3, $greetings);
        $this->assertTrue($greetings->every(fn (WidgetGreeting $greeting): bool => $greeting->is_active && $greeting->weight === 1 && $greeting->body !== ''));
        $this->assertSame([0, 1, 2], $greetings->pluck('sort_order')->all());
    }

    public function test_the_first_administrator_serves_the_general_category_so_the_first_visitor_reaches_somebody(): void
    {
        $this->install();
        $this->postJson(route('setup.run', 'create-admin'))->assertJsonPath('status', 'ok');

        $admin = User::query()->where('is_admin', true)->firstOrFail();
        $category = Category::query()->where('slug', 'general')->firstOrFail();

        $this->assertTrue($admin->is_agent);
        $this->assertSame([$category->id], $admin->categories()->pluck('categories.id')->all());

        // Running the step again does not duplicate the link.
        $this->postJson(route('setup.run', 'create-admin'))->assertJsonPath('status', 'ok');
        $this->assertSame(1, $admin->categories()->count());
    }

    public function test_seeding_is_idempotent(): void
    {
        $this->install();
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');
        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame(1, Category::query()->count());
        $this->assertSame(1, Widget::query()->count());
        $this->assertSame(3, WidgetGreeting::query()->count());
    }

    public function test_seeding_never_clobbers_what_an_admin_changed_in_the_meantime(): void
    {
        $this->install();

        Category::query()->where('slug', 'general')->update(['name' => 'Everything else', 'is_active' => false]);
        Widget::query()->update(['name' => 'Renamed', 'is_enabled' => true]);

        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame('Everything else', Category::query()->where('slug', 'general')->value('name'));
        $this->assertSame('Renamed', Widget::query()->value('name'));
        $this->assertTrue(Widget::query()->value('is_enabled'));
        $this->assertSame(1, Widget::query()->count());
    }

    public function test_a_deleted_sample_widget_is_not_resurrected_by_a_later_run(): void
    {
        $this->install();
        Widget::query()->firstOrFail()->delete();

        $this->postJson(route('setup.run', 'seed-defaults'))->assertJsonPath('status', 'ok');

        $this->assertSame(0, Widget::query()->count());
        $this->assertSame(1, Widget::onlyTrashed()->count());
    }
}
