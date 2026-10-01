<?php

namespace Tests\Feature\Widgets;

use App\Domain\Widgets\Actions\PublishWidget;
use App\Domain\Widgets\Actions\SaveDraft;
use App\Domain\Widgets\Actions\UpdateWidget;
use App\Domain\Widgets\Config\ConfigResolver;
use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\AuditLog;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\WidgetFixtures;
use Tests\TestCase;

/**
 * Settings, draft and publish touch the same JSON columns from different requests: whatever the interleaving, nobody
 * writes back a stale copy; and caches are only busted once the change is visible to other connections.
 */
class WidgetConsistencyTest extends TestCase
{
    use RefreshDatabase, WidgetFixtures;

    private Widget $widget;

    protected function setUp(): void
    {
        parent::setUp();

        $this->widget = $this->enabledWidget();
    }

    /**
     * @param  array<string, mixed>  $overrides  dotted path => value on top of the defaults
     * @return array<string, mixed>
     */
    private function configWith(array $overrides): array
    {
        $config = (new WidgetConfigData)->toArray();

        foreach ($overrides as $path => $value) {
            data_set($config, $path, $value);
        }

        return $config;
    }

    private function fresh(): Widget
    {
        return Widget::query()->findOrFail($this->widget->id);
    }

    public function test_a_settings_update_from_a_stale_model_does_not_undo_a_publish(): void
    {
        // The route-bound model of the settings request, loaded BEFORE the publish below happens in another request.
        $stale = $this->fresh();

        app(SaveDraft::class)->handle($this->fresh(), $this->configWith(['theme.primary' => '#123456']));
        app(PublishWidget::class)->handle($this->fresh());
        $this->assertSame(2, $this->fresh()->config_version);

        app(UpdateWidget::class)->handle($stale, ['locale' => 'ar', 'timezone' => 'Asia/Riyadh']);

        $widget = $this->fresh();
        $this->assertSame('#123456', $widget->config['theme']['primary'], 'the published config keeps what the publish wrote');
        $this->assertSame(2, $widget->config_version);
        $this->assertSame('ar', $widget->locale);
        $this->assertSame('ar', $widget->config['defaultLocale'], 'the mirrored fields follow the settings change');
        $this->assertSame('Asia/Riyadh', $widget->config['hours']['timezone']);
        $this->assertSame('ar', $widget->draft_config['defaultLocale']);
        $this->assertSame('#123456', $widget->draft_config['theme']['primary']);
    }

    public function test_a_settings_update_from_a_stale_model_does_not_undo_a_draft_save(): void
    {
        $stale = $this->fresh();

        app(SaveDraft::class)->handle($this->fresh(), $this->configWith(['theme.accent' => '#abcdef', 'launcher.label' => 'Ask us']));

        app(UpdateWidget::class)->handle($stale, ['idle_timeout_minutes' => 30]);

        $widget = $this->fresh();
        $this->assertSame('#abcdef', $widget->draft_config['theme']['accent'], 'unpublished draft edits survive');
        $this->assertSame('Ask us', $widget->draft_config['launcher']['label']);
        $this->assertSame(30, $widget->draft_config['session']['idleTimeoutMinutes']);
        $this->assertSame(30, $widget->config['session']['idleTimeoutMinutes']);
        $this->assertNotSame('#abcdef', $widget->config['theme']['accent'], 'and stay unpublished');
    }

    public function test_the_returned_widget_reflects_the_database_not_the_stale_input(): void
    {
        $stale = $this->fresh();
        app(PublishWidget::class)->handle($this->fresh());

        $updated = app(UpdateWidget::class)->handle($stale, ['name' => 'Renamed']);

        $this->assertSame('Renamed', $updated->name);
        $this->assertSame(2, $updated->config_version);
    }

    public function test_a_draft_save_from_a_stale_model_audits_the_current_version(): void
    {
        $stale = $this->fresh();
        app(PublishWidget::class)->handle($this->fresh());

        app(SaveDraft::class)->handle($stale, $this->configWith(['theme.primary' => '#111111']));

        $audit = AuditLog::query()->where('action', 'widget.draft_saved')->latest('id')->firstOrFail();
        $this->assertSame(2, $audit->changes['config_version']);
        $this->assertSame('#111111', $this->fresh()->draft_config['theme']['primary']);
        $this->assertSame(2, $this->fresh()->config_version);
    }

    public function test_a_settings_update_busts_the_cache_only_after_the_commit(): void
    {
        $cache = app(WidgetCache::class);
        $before = $cache->key($this->widget, 'boot');

        DB::transaction(function () use ($cache, $before): void {
            app(UpdateWidget::class)->handle($this->fresh(), ['name' => 'Renamed']);

            $this->assertSame($before, $cache->key($this->widget, 'boot'), 'readers must not refill the cache with the old rows before the commit');
        });

        $this->assertNotSame($before, $cache->key($this->widget, 'boot'));
    }

    public function test_a_bust_outside_a_transaction_takes_effect_at_once(): void
    {
        $cache = app(WidgetCache::class);
        $before = $cache->key($this->widget, 'boot');

        $cache->bust($this->widget);

        $this->assertNotSame($before, $cache->key($this->widget, 'boot'));
    }

    public function test_a_rolled_back_change_does_not_bust_the_cache(): void
    {
        $cache = app(WidgetCache::class);
        $before = $cache->key($this->widget, 'boot');

        try {
            DB::transaction(function () use ($cache): void {
                $cache->bust($this->widget);

                throw new \RuntimeException('rolled back');
            });
        } catch (\RuntimeException) {
        }

        $this->assertSame($before, $cache->key($this->widget, 'boot'));
    }

    public function test_the_boot_config_follows_a_changed_app_url_without_waiting_for_the_cache(): void
    {
        $resolver = app(ConfigResolver::class);

        settings()->set('app.url', 'https://chat.one.test');
        $this->assertSame('https://chat.one.test/api/v1/public', $resolver->resolveArray($this->widget)['api']['base']);

        settings()->set('app.url', 'https://chat.two.test');
        $boot = $resolver->resolveArray($this->widget);

        $this->assertSame('https://chat.two.test/api/v1/public', $boot['api']['base']);
        $this->assertSame('https://chat.two.test/embed/'.$this->widget->public_key, $boot['api']['embed']);
        $this->assertSame('https://chat.two.test', $boot['api']['appOrigin']);
    }
}
