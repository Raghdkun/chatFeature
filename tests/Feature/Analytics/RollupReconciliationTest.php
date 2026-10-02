<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\Actions\RollupDay;
use App\Domain\Analytics\Actions\RollupRange;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\Collection\MetricCalculator;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\AnalyticsDataset;
use Tests\Support\AssertsAnalytics;
use Tests\TestCase;

/**
 * The rollup against the independent computation (tests/Support/AnalyticsReference.php: every raw row loaded and counted in plain PHP),
 * over a generated dataset with every state, midnights and a DST change. Runs on SQLite by default and on MySQL with
 * `DB_CONNECTION=mysql DB_DATABASE=<a dedicated database> php artisan test tests/Feature/Analytics` (same code, same assertions).
 */
class RollupReconciliationTest extends TestCase
{
    use AssertsAnalytics, RefreshDatabase;

    private const FIRST_DAY = '2026-03-20';

    private const DAYS = 18;

    private AnalyticsDataset $dataset;

    protected function setUp(): void
    {
        parent::setUp();

        $this->dataset = (new AnalyticsDataset)->generate(self::FIRST_DAY, self::DAYS, 10);
    }

    /**
     * @return list<string> the generated days and a few after them (where the late events of the last chats land)
     */
    private function days(): array
    {
        $days = [];

        for ($d = -1; $d < self::DAYS + 6; $d++) {
            $days[] = CarbonImmutable::createFromFormat('!Y-m-d', self::FIRST_DAY, 'UTC')->addDays($d)->format('Y-m-d');
        }

        return $days;
    }

    public function test_every_day_matches_the_reference_in_utc(): void
    {
        $this->assertGreaterThan(150, $this->dataset->conversations);

        foreach ($this->days() as $date) {
            $this->assertRollupMatchesReference($date, 'UTC');
        }
    }

    public function test_every_day_matches_the_reference_in_a_dst_time_zone(): void
    {
        // Europe/Berlin: summer time starts on 2026-03-29 (a 23-hour day) and the chats near 22:00-23:00 UTC sit on its boundaries.
        foreach ($this->days() as $date) {
            $this->assertRollupMatchesReference($date, 'Europe/Berlin');
        }
    }

    public function test_a_half_hour_zone_matches_too(): void
    {
        foreach (array_slice($this->days(), 4, 6) as $date) {
            $this->assertRollupMatchesReference($date, 'Asia/Kolkata');
        }
    }

    public function test_the_widget_and_topic_rows_add_up_to_the_total(): void
    {
        app(RollupRange::class)->handle('2026-03-19', '2026-04-12');

        $additive = array_values(array_diff(AnalyticsColumns::CHAT_COUNTERS, ['transferred']));
        $conversationColumns = array_values(array_diff($additive, ['messages_agent', 'offers', 'handled', 'reclaimed']));

        foreach (DB::table('analytics_daily')->where('dimension', 'total')->get() as $total) {
            foreach (['widget', 'category'] as $dimension) {
                $rows = DB::table('analytics_daily')->where('date', $total->date)->where('dimension', $dimension)->get();

                foreach ($additive as $column) {
                    $this->assertSame((int) $total->{$column}, (int) $rows->sum($column), "{$total->date} {$column} over {$dimension} rows");
                }
            }
        }

        $this->assertNotEmpty($conversationColumns);
    }

    public function test_the_agent_rows_add_up_to_the_total_for_what_an_agent_causes(): void
    {
        app(RollupRange::class)->handle('2026-03-19', '2026-04-12');

        $perAgent = ['handled', 'reclaimed', 'transferred', 'ended', 'res_visitor', 'res_agent', 'res_system', 'res_idle', 'wait_sum_s', 'wait_count',
            'frt_sum_s', 'frt_count', 'handling_sum_s', 'handling_count', 'msgs_sum', 'msgs_count', 'messages_agent', 'rating_count', 'rating_sum',
            'rating_1', 'rating_2', 'rating_3', 'rating_4', 'rating_5', 'offers', 'offline_answered', 'offline_response_sum_s'];

        foreach (DB::table('analytics_daily')->where('dimension', 'total')->get() as $total) {
            $agents = DB::table('analytics_daily')->where('date', $total->date)->where('dimension', 'agent')->get();

            foreach ($perAgent as $column) {
                $this->assertSame((int) $total->{$column}, (int) $agents->sum($column), "{$total->date} {$column} over agent rows");
            }
        }
    }

    public function test_the_numbers_are_not_trivially_zero(): void
    {
        app(RollupRange::class)->handle('2026-03-19', '2026-04-12');

        $sum = fn (string $column): int => (int) DB::table('analytics_daily')->where('dimension', 'total')->sum($column);

        foreach (['started', 'handled', 'reclaimed', 'transferred', 'missed', 'ended', 'closed_rated', 'closed_skipped', 'closed_idle', 'closed_timeout',
            'closed_system', 'closed_cancelled', 'res_visitor', 'res_agent', 'res_system', 'res_idle', 'wait_sum_s', 'frt_sum_s', 'handling_sum_s',
            'messages_visitor', 'messages_agent', 'rating_count', 'offers', 'offline_created', 'offline_answered', 'offline_closed'] as $column) {
            $this->assertGreaterThan(0, $sum($column), "{$column} should have been exercised by the dataset");
        }

        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'total')->max('peak_concurrent'));
        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'total')->max('queue_peak'));
        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'whatsapp')->sum('wa_inbound'));
        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'whatsapp')->sum('wa_outbound'));
        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'whatsapp')->sum('wa_response_count'));
        $this->assertGreaterThan(0, (int) DB::table('analytics_daily')->where('dimension', 'whatsapp')->sum('wa_chats_linked'));
    }

    public function test_a_rerun_gives_the_same_rows_and_the_same_ids_are_not_needed(): void
    {
        $roll = fn () => app(RollupRange::class)->handle('2026-03-19', '2026-04-12', true);

        $roll();
        $first = DB::table('analytics_daily')->orderBy('date')->orderBy('dimension')->orderBy('dimension_key')->get()->map(fn ($row) => collect((array) $row)->except(['id', 'computed_at', 'sealed_at'])->all())->all();
        $slots = DB::table('analytics_slots')->count();

        $roll();
        $second = DB::table('analytics_daily')->orderBy('date')->orderBy('dimension')->orderBy('dimension_key')->get()->map(fn ($row) => collect((array) $row)->except(['id', 'computed_at', 'sealed_at'])->all())->all();

        $this->assertEquals($first, $second);
        $this->assertSame($slots, DB::table('analytics_slots')->count());
        $this->assertSame(0, DB::table('analytics_daily')->select('date', 'dimension', 'dimension_key')->groupBy('date', 'dimension', 'dimension_key')->havingRaw('COUNT(*) > 1')->get()->count());
    }

    public function test_the_live_day_and_the_stored_day_are_the_same_numbers(): void
    {
        $calculator = app(MetricCalculator::class);

        foreach (['2026-03-24', '2026-03-29'] as $date) {
            app(RollupDay::class)->handle($date, true, 'UTC');
            $live = $calculator->forDay($date, 'UTC');
            $rows = [];

            foreach ($live->rows() as $row) {
                $rows[$row['dimension']][$row['key']] = $row['values'];
            }

            $this->assertSame([], $this->differences($this->normalise($rows), $this->storedRows($date)), 'live vs stored for '.$date);
        }
    }
}
