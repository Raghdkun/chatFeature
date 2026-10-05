<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\Actions\RollupDay;
use App\Domain\Analytics\Actions\RollupRange;
use App\Domain\Settings\Facades\Settings;
use App\Models\Category;
use App\Models\User;
use App\Models\WaChat;
use App\Models\WaMessage;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Console\Scheduling\Schedule;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Tests\Support\AnalyticsWorld;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

class RollupCommandTest extends TestCase
{
    use InteractsWithAnalytics, RefreshDatabase;

    private AnalyticsWorld $world;

    private User $agent;

    protected function setUp(): void
    {
        parent::setUp();

        $this->disableAnalyticsCaches();
        $widget = Widget::factory()->create();
        $this->world = new AnalyticsWorld($widget, Category::factory()->create());
        $this->agent = User::factory()->agent()->create();
    }

    private function started(string $date): int
    {
        return (int) DB::table('analytics_daily')->where('date', $date)->where('dimension', 'total')->value('started');
    }

    private function sealed(string $date): bool
    {
        return DB::table('analytics_daily')->where('date', $date)->where('dimension', 'total')->whereNotNull('sealed_at')->exists();
    }

    public function test_a_backfill_rolls_every_day_of_the_range_and_reports_it(): void
    {
        $this->world->chat('2026-03-10 09:00:00')->save();
        $this->world->chat('2026-03-12 09:00:00')->save();

        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-12'])
            ->expectsOutputToContain('2026-03-10')
            ->expectsOutputToContain('Rolled up 3 day(s), skipped 0.')
            ->assertSuccessful();

        $this->assertSame(1, $this->started('2026-03-10'));
        $this->assertSame(0, $this->started('2026-03-11'));
        $this->assertSame(1, $this->started('2026-03-12'));
        $this->assertSame(3, DB::table('analytics_daily')->where('dimension', 'total')->count(), 'a quiet day is a row of zeros');
    }

    public function test_a_day_older_than_three_days_is_sealed_and_a_rerun_leaves_it_alone(): void
    {
        $this->world->chat('2026-03-10 09:00:00')->save();
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->assertSuccessful();
        $this->assertTrue($this->sealed('2026-03-10'));

        // The raw data changes afterwards (a late fix, an import): the sealed day does not move...
        $this->world->chat('2026-03-10 10:00:00')->save();
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])
            ->expectsOutputToContain('skipped: sealed')
            ->assertSuccessful();
        $this->assertSame(1, $this->started('2026-03-10'));

        // ...until somebody asks for a rebuild.
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10', '--force' => true])->assertSuccessful();
        $this->assertSame(2, $this->started('2026-03-10'));
    }

    public function test_force_with_a_number_of_days_rebuilds_the_last_days_sealed_ones_included(): void
    {
        $this->travelTo(CarbonImmutable::parse('2026-03-20 12:00:00', 'UTC'));
        $this->world->chat('2026-03-10 09:00:00')->save();
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->assertSuccessful();
        $this->assertTrue($this->sealed('2026-03-10'));

        $this->world->chat('2026-03-10 10:00:00')->save();

        // Without --force the sealed day stays; `--days=35 --force` used to behave like that too (the option was ignored).
        $this->artisan('analytics:rollup', ['--days' => 35])->assertSuccessful();
        $this->assertSame(1, $this->started('2026-03-10'));

        $this->artisan('analytics:rollup', ['--days' => 35, '--force' => true])->assertSuccessful();
        $this->assertSame(2, $this->started('2026-03-10'));
    }

    public function test_the_last_days_stay_open_until_they_are_old_enough(): void
    {
        $today = now()->format('Y-m-d');
        $yesterday = now()->subDay()->format('Y-m-d');
        $fourDaysAgo = now()->subDays(4)->format('Y-m-d');

        $this->artisan('analytics:rollup', ['--from' => $fourDaysAgo, '--to' => $today])->assertSuccessful();

        $this->assertTrue($this->sealed($fourDaysAgo));
        $this->assertFalse($this->sealed($yesterday));
        $this->assertFalse($this->sealed($today));
    }

    public function test_the_default_run_catches_up_on_every_unsealed_day_of_the_last_35_days_and_no_further(): void
    {
        $recent = now()->subDays(10);
        $old = now()->subDays(60);
        $this->world->chat($recent->format('Y-m-d').' 09:00:00')->save();
        $this->world->chat($old->format('Y-m-d').' 09:00:00')->save();

        $this->artisan('analytics:rollup')->assertSuccessful();

        $this->assertSame(1, $this->started($recent->format('Y-m-d')));
        $this->assertSame(0, DB::table('analytics_daily')->where('date', $old->format('Y-m-d'))->count(), 'older history needs an explicit --from');
        $this->assertTrue($this->sealed($recent->format('Y-m-d')));

        // The next default run has only today (and the days that are still open) to do.
        $this->artisan('analytics:rollup')->expectsOutputToContain('skipped 0')->assertSuccessful();
        $pending = app(RollupRange::class)->pending();
        $this->assertContains(now()->format('Y-m-d'), $pending);
        $this->assertNotContains($recent->format('Y-m-d'), $pending);
    }

    public function test_the_hourly_option_only_looks_a_couple_of_days_back(): void
    {
        $this->world->chat(now()->subDays(10)->format('Y-m-d').' 09:00:00')->save();

        $this->artisan('analytics:rollup', ['--days' => 2])->assertSuccessful();

        $this->assertSame(3, DB::table('analytics_daily')->where('dimension', 'total')->count(), 'today and the two days before it');
    }

    public function test_today_only_rolls_today(): void
    {
        $this->artisan('analytics:rollup', ['--today' => true])->assertSuccessful();

        $this->assertSame([now()->format('Y-m-d')], DB::table('analytics_daily')->pluck('date')->map(fn ($date) => substr((string) $date, 0, 10))->all());
    }

    public function test_bad_arguments_are_refused_and_nothing_is_written(): void
    {
        $this->artisan('analytics:rollup', ['--to' => '2026-03-10'])->expectsOutputToContain('--to needs --from')->assertExitCode(2);
        $this->artisan('analytics:rollup', ['--from' => 'garbage'])->expectsOutputToContain('Not a Y-m-d date')->assertExitCode(2);
        $this->artisan('analytics:rollup', ['--from' => '2026-03-12', '--to' => '2026-03-10'])->expectsOutputToContain('after its end')->assertExitCode(2);
        $this->artisan('analytics:rollup', ['--from' => '2026-02-30'])->assertExitCode(2);

        $this->assertSame(0, DB::table('analytics_daily')->count());
    }

    public function test_a_second_run_while_one_is_running_stops_at_once(): void
    {
        $lock = Cache::lock('analytics:rollup', 60);
        $this->assertTrue($lock->get());

        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])
            ->expectsOutputToContain('Another analytics:rollup is running')
            ->assertSuccessful();

        $this->assertSame(0, DB::table('analytics_daily')->count());
        $lock->release();
    }

    public function test_the_runs_are_scheduled_without_overlap_on_one_server(): void
    {
        $events = collect(app(Schedule::class)->events())->filter(fn ($event) => str_contains((string) $event->command, 'analytics:rollup'));

        $this->assertCount(2, $events);

        $hourly = $events->first(fn ($event) => str_contains((string) $event->command, '--days=2'));
        $nightly = $events->first(fn ($event) => ! str_contains((string) $event->command, '--days'));

        $this->assertSame('7 * * * *', $hourly->expression);
        $this->assertSame('25 0 * * *', $nightly->expression);

        foreach ([$hourly, $nightly] as $event) {
            $this->assertTrue($event->withoutOverlapping);
            $this->assertTrue($event->onOneServer);
        }
    }

    public function test_rolling_a_day_replaces_it_instead_of_adding_to_it(): void
    {
        $this->world->chat('2026-03-10 09:00:00')->claimedBy($this->agent, 30)->save();
        $roll = fn () => app(RollupDay::class)->handle('2026-03-10', true, 'UTC');

        $roll();
        $roll();
        $roll();

        $this->assertSame(1, $this->started('2026-03-10'));
        $this->assertSame(1, (int) DB::table('analytics_daily')->where('dimension', 'agent')->where('dimension_key', (string) $this->agent->id)->value('handled'));
        $this->assertSame(1, DB::table('analytics_daily')->where('dimension', 'total')->count());
    }

    public function test_a_number_that_falls_to_zero_disappears_on_a_rerun(): void
    {
        $chat = $this->world->chat('2026-03-10 09:00:00')->claimedBy($this->agent, 30)->save();
        app(RollupDay::class)->handle('2026-03-10', true, 'UTC');
        $this->assertSame(1, DB::table('analytics_daily')->where('dimension', 'agent')->count());

        $chat->delete();
        app(RollupDay::class)->handle('2026-03-10', true, 'UTC');

        $this->assertSame(0, DB::table('analytics_daily')->where('dimension', 'agent')->count());
        $this->assertSame(0, $this->started('2026-03-10'));
    }

    public function test_deleting_widgets_topics_agents_and_chats_does_not_change_sealed_history(): void
    {
        $widget = $this->world->widget;
        $category = $this->world->category;
        $this->world->chat('2026-03-10 09:00:00')->claimedBy($this->agent, 30)->agentSays(10)->endedBy('visitor', 200)->rated(5, 30)->save();
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->assertSuccessful();
        $before = DB::table('analytics_daily')->where('date', '2026-03-10')->orderBy('dimension')->orderBy('dimension_key')->get()->map(fn ($row) => (array) $row)->all();

        $this->agent->delete();
        $category->forceDelete();
        $widget->forceDelete();             // cascades to its conversations, messages, events, ratings
        $this->assertSame(0, DB::table('conversations')->count());

        $this->artisan('analytics:rollup')->assertSuccessful();                                   // nothing sealed is touched
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->expectsOutputToContain('sealed')->assertSuccessful();

        $after = DB::table('analytics_daily')->where('date', '2026-03-10')->orderBy('dimension')->orderBy('dimension_key')->get()->map(fn ($row) => (array) $row)->all();
        $this->assertSame($before, $after);
        $this->assertSame(1, $this->started('2026-03-10'));
    }

    public function test_whatsapp_chats_deleted_by_retention_do_not_change_past_rollups(): void
    {
        $chat = WaChat::factory()->create(['created_at' => '2026-03-10 09:00:00']);
        WaMessage::factory()->create(['wa_chat_id' => $chat->id, 'wa_timestamp' => '2026-03-10 09:00:10', 'created_at' => '2026-03-10 09:00:10']);
        WaMessage::factory()->outbound()->create(['wa_chat_id' => $chat->id, 'wa_timestamp' => '2026-03-10 09:05:10', 'created_at' => '2026-03-10 09:05:10']);

        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->assertSuccessful();
        $row = fn () => (array) DB::table('analytics_daily')->where('date', '2026-03-10')->where('dimension', 'whatsapp')->first();
        $this->assertSame([1, 1, 1, 300, 1], [$row()['wa_chats_new'], $row()['wa_inbound'], $row()['wa_outbound'], $row()['wa_response_sum_s'], $row()['wa_response_count']]);

        // What `whatsapp:prune` (retention) or an erasure request does.
        Settings::set('whatsapp.retention_days', 30);
        WaMessage::query()->delete();
        WaChat::query()->delete();

        // Not recomputed while sealed...
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10'])->expectsOutputToContain('sealed')->assertSuccessful();
        $this->assertSame(1, $row()['wa_chats_new']);

        // ...and even a forced rebuild of the day keeps its WhatsApp rows once the retention setting says the messages may be gone.
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-10', '--force' => true])
            ->expectsOutputToContain('WhatsApp rows kept: retention')
            ->assertSuccessful();
        $this->assertSame(1, $row()['wa_chats_new']);
        $this->assertSame(1, $row()['wa_inbound']);
        $this->assertSame(300, $row()['wa_response_sum_s']);
    }

    public function test_a_recent_whatsapp_day_is_still_recomputed_under_a_retention_setting(): void
    {
        Settings::set('whatsapp.retention_days', 30);
        $yesterday = now()->subDay();
        WaChat::factory()->create(['created_at' => $yesterday]);

        app(RollupDay::class)->handle($yesterday->format('Y-m-d'), true, 'UTC');

        $this->assertSame(1, (int) DB::table('analytics_daily')->where('date', $yesterday->format('Y-m-d'))->where('dimension', 'whatsapp')->value('wa_chats_new'));
    }

    public function test_a_changed_time_zone_is_recorded_on_the_rows_and_a_rebuild_fixes_it(): void
    {
        $this->world->chat('2026-03-10 23:30:00')->save();      // 00:30 on the 11th in Berlin
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-11'])->assertSuccessful();
        $this->assertSame(1, $this->started('2026-03-10'));
        $this->assertSame('UTC', DB::table('analytics_daily')->where('date', '2026-03-10')->value('tz'));

        Settings::set('app.timezone', 'Europe/Berlin');
        $this->artisan('analytics:rollup', ['--from' => '2026-03-10', '--to' => '2026-03-11', '--force' => true])->assertSuccessful();

        $this->assertSame(0, $this->started('2026-03-10'));
        $this->assertSame(1, $this->started('2026-03-11'));
        $this->assertSame('Europe/Berlin', DB::table('analytics_daily')->where('date', '2026-03-11')->value('tz'));
    }

    public function test_the_pending_list_starts_at_the_horizon_and_skips_sealed_days(): void
    {
        $range = app(RollupRange::class);
        $today = CarbonImmutable::now('UTC');

        $this->assertCount(36, $range->pending(), '35 days back, and today');
        $this->assertSame($today->subDays(35)->format('Y-m-d'), $range->pending()[0]);
        $this->assertCount(3, $range->pending(2));

        $this->artisan('analytics:rollup', ['--from' => $today->subDays(35)->format('Y-m-d'), '--to' => $today->subDays(30)->format('Y-m-d')])->assertSuccessful();

        $this->assertCount(30, $range->pending());
    }
}
