<?php

namespace Tests\Feature\Analytics;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

/**
 * The numbers the API returns against the independent reference (raw rows, plain loops) for the same range.
 */
class AnalyticsApiTest extends TestCase
{
    use InteractsWithAnalytics, RefreshDatabase;

    private User $admin;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics();
        $this->admin = $this->dataset->admin;
    }

    /**
     * @param  array<string, mixed>  $query
     * @return array<string, mixed>
     */
    private function fetch(string $path, array $query = [], ?User $as = null): array
    {
        return $this->actingAs($as ?? $this->admin, 'sanctum')->getJson('/api/v1/analytics/'.$path.'?'.http_build_query($query))->assertOk()->json('data');
    }

    public function test_the_overview_matches_the_reference_over_the_whole_range(): void
    {
        $expected = $this->expectedRow('2026-03-20', '2026-03-27');
        $data = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27']);
        $kpis = $data['current'];

        $this->assertSame(['from' => '2026-03-20', 'to' => '2026-03-27', 'days' => 8], $data['range']);
        $this->assertNull($data['previous']);
        $this->assertSame($expected['started'], $kpis['started']);
        $this->assertSame($expected['handled'], $kpis['handled']);
        $this->assertSame($expected['missed'], $kpis['missed']);
        $this->assertSame($expected['closed_cancelled'], $kpis['cancelled']);
        $this->assertSame($expected['ended'], $kpis['ended']);
        $this->assertEqualsWithDelta($this->ratio($expected['wait_sum_s'], $expected['wait_count']), $kpis['wait']['averageSeconds'], 1e-9);
        $this->assertSame($expected['wait_max_s'], $kpis['wait']['maxSeconds']);
        $this->assertEqualsWithDelta($this->ratio($expected['frt_sum_s'], $expected['frt_count']), $kpis['firstResponse']['averageSeconds'], 1e-9);
        $this->assertEqualsWithDelta($this->ratio($expected['handling_sum_s'], $expected['handling_count']), $kpis['handling']['averageSeconds'], 1e-9);
        $this->assertEqualsWithDelta($this->ratio($expected['msgs_sum'], $expected['msgs_count']), $kpis['messages']['perChat'], 1e-9);
        $this->assertSame($expected['messages_visitor'], $kpis['messages']['visitor']);
        $this->assertSame($expected['messages_agent'], $kpis['messages']['agent']);
        $this->assertSame($expected['peak_concurrent'], $kpis['peakConcurrent']);
        $this->assertSame($expected['queue_peak'], $kpis['queuePeak']);
        $this->assertSame([$expected['res_visitor'], $expected['res_agent'], $expected['res_system'], $expected['res_idle']], array_values($kpis['resolution']));
        $this->assertSame($expected['rating_count'], $kpis['ratings']['count']);
        $this->assertSame([$expected['rating_1'], $expected['rating_2'], $expected['rating_3'], $expected['rating_4'], $expected['rating_5']], $kpis['ratings']['distribution']);
        $this->assertEqualsWithDelta($this->ratio($expected['rating_sum'], $expected['rating_count']), $kpis['ratings']['average'], 1e-9);
        $this->assertEqualsWithDelta($this->ratio($expected['handled'], $expected['handled'] + $expected['missed']), $kpis['answerRate'], 1e-9);
        $this->assertSame($expected['offline_created'], $kpis['offline']['created']);
        $this->assertSame($expected['offline_answered'], $kpis['offline']['answered']);
        $this->assertSame($expected['offline_closed'], $kpis['offline']['closed']);
        $this->assertGreaterThan(0, $kpis['started']);
        $this->assertGreaterThan(0, $kpis['ratings']['count']);
    }

    public function test_an_average_over_a_range_is_the_sum_over_the_sum_not_an_average_of_averages(): void
    {
        $perDay = [];

        for ($d = 20; $d <= 27; $d++) {
            $row = $this->expectedRow("2026-03-{$d}", "2026-03-{$d}");
            $perDay[] = $this->ratio($row['wait_sum_s'], $row['wait_count']);
        }

        $averageOfAverages = array_sum(array_filter($perDay, fn ($v) => $v !== null)) / count(array_filter($perDay, fn ($v) => $v !== null));
        $overview = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27'])['current']['wait']['averageSeconds'];
        $expected = $this->expectedRow('2026-03-20', '2026-03-27');

        $this->assertEqualsWithDelta($expected['wait_sum_s'] / $expected['wait_count'], $overview, 1e-9);
        $this->assertNotEqualsWithDelta($averageOfAverages, $overview, 1e-6, 'the dataset must make the two definitions differ');
    }

    public function test_compare_returns_the_previous_equally_long_range(): void
    {
        $data = $this->fetch('overview', ['from' => '2026-03-24', 'to' => '2026-03-27', 'compare' => 1]);

        $this->assertSame(['from' => '2026-03-20', 'to' => '2026-03-23', 'days' => 4], $data['previousRange']);
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-23')['started'], $data['previous']['started']);
        $this->assertSame($this->expectedRow('2026-03-24', '2026-03-27')['started'], $data['current']['started']);
    }

    public function test_a_widget_topic_and_agent_filter_read_their_own_rows(): void
    {
        $widget = $this->dataset->widgets[1];
        $category = $this->dataset->categories[0];
        $agent = $this->dataset->agents[2];

        $byWidget = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27', 'widget' => $widget->ulid]);
        $byCategory = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27', 'category' => $category->ulid]);
        $byAgent = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27', 'agent' => $agent->id]);

        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27', 'widget', (string) $widget->id)['started'], $byWidget['current']['started']);
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27', 'category', (string) $category->id)['started'], $byCategory['current']['started']);
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27', 'agent', (string) $agent->id)['handled'], $byAgent['current']['handled']);
        $this->assertSame(['role' => 'admin', 'dimension' => 'widget', 'key' => $widget->ulid, 'whatsapp' => true], $byWidget['scope']);
        $this->assertNull($byAgent['current']['started'], 'a chat start has no agent');
    }

    public function test_an_agent_sees_exactly_their_own_row(): void
    {
        $agent = $this->dataset->agents[1];
        $mine = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27'], $agent);
        $expected = $this->expectedRow('2026-03-20', '2026-03-27', 'agent', (string) $agent->id);

        $this->assertSame(['role' => 'agent', 'dimension' => 'agent', 'key' => (string) $agent->id, 'whatsapp' => false], $mine['scope']);
        $this->assertSame($expected['handled'], $mine['current']['handled']);
        $this->assertSame($expected['messages_agent'], $mine['current']['messages']['agent']);
        $this->assertSame($expected['rating_count'], $mine['current']['ratings']['count']);
        $this->assertSame($expected['peak_concurrent'], $mine['current']['peakConcurrent']);
        $this->assertNull($mine['current']['started']);
        $this->assertNull($mine['current']['missed']);
        $this->assertNull($mine['current']['queuePeak']);
        $this->assertNull($mine['current']['offline']['created']);
        $this->assertGreaterThan(0, $mine['current']['handled']);
    }

    public function test_the_timeseries_buckets_add_up_to_the_range(): void
    {
        $day = $this->fetch('timeseries', ['from' => '2026-03-20', 'to' => '2026-03-27', 'metric' => 'started,handled,wait_avg', 'interval' => 'day']);
        $week = $this->fetch('timeseries', ['from' => '2026-03-20', 'to' => '2026-03-27', 'metric' => 'started', 'interval' => 'week']);
        $month = $this->fetch('timeseries', ['from' => '2026-03-20', 'to' => '2026-04-03', 'metric' => 'started', 'interval' => 'month']);

        $this->assertSame(['started', 'handled', 'wait_avg'], array_column($day['series'], 'metric'));
        $this->assertSame(['count', 'count', 'seconds'], array_column($day['series'], 'unit'));
        $this->assertCount(8, $day['series'][0]['points']);

        foreach ($day['series'][0]['points'] as $point) {
            $this->assertSame($this->expectedRow($point['date'], $point['date'])['started'], (int) $point['value'], $point['date']);
            $this->assertSame(1, $point['days']);
        }

        // 2026-03-20 is a Friday: weeks start on Monday the 16th (a partial first bucket of 3 days), the 23rd (5 days).
        $this->assertSame(['2026-03-16', '2026-03-23'], array_column($week['series'][0]['points'], 'date'));
        $this->assertSame([3, 5], array_column($week['series'][0]['points'], 'days'));
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-22')['started'], (int) $week['series'][0]['points'][0]['value']);
        $this->assertSame($this->expectedRow('2026-03-23', '2026-03-27')['started'], (int) $week['series'][0]['points'][1]['value']);

        $this->assertSame(['2026-03-01', '2026-04-01'], array_column($month['series'][0]['points'], 'date'));
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-31')['started'], (int) $month['series'][0]['points'][0]['value']);
    }

    public function test_a_week_average_is_the_weeks_total_over_the_weeks_samples(): void
    {
        $week = $this->fetch('timeseries', ['from' => '2026-03-23', 'to' => '2026-03-29', 'metric' => 'frt_avg', 'interval' => 'week']);
        $expected = $this->expectedRow('2026-03-23', '2026-03-29');

        $this->assertEqualsWithDelta($expected['frt_sum_s'] / $expected['frt_count'], $week['series'][0]['points'][0]['value'], 1e-9);
    }

    public function test_the_breakdown_lists_every_row_with_activity_busiest_first(): void
    {
        $data = $this->fetch('breakdown', ['from' => '2026-03-20', 'to' => '2026-03-27', 'by' => 'category']);
        $rows = $data['rows'];
        $started = array_map(fn ($row) => $row['kpis']['started'], $rows);

        $this->assertSame($started, collect($started)->sortDesc()->values()->all(), 'busiest first');
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27')['started'], array_sum($started), 'the topics add up to the total (a missing topic is its own row)');
        $this->assertContains('No topic', array_column($rows, 'label'));
        $this->assertSame(array_sum($started), array_sum(array_map(fn ($row) => array_sum($row['sparkline']), $rows)), 'the sparkline holds the same volume');

        $agents = $this->fetch('breakdown', ['from' => '2026-03-20', 'to' => '2026-03-27', 'by' => 'agent'])['rows'];
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27')['handled'], array_sum(array_map(fn ($row) => $row['kpis']['handled'], $agents)));
        $this->assertContains('Agent 1', array_column($agents, 'label'));
    }

    public function test_deleted_widgets_topics_and_accounts_keep_their_numbers(): void
    {
        $widget = $this->dataset->widgets[1];
        $category = $this->dataset->categories[2];
        $agent = $this->dataset->agents[3];
        $before = [
            'widget' => $this->expectedRow('2026-03-20', '2026-03-27', 'widget', (string) $widget->id)['started'],
            'category' => $this->expectedRow('2026-03-20', '2026-03-27', 'category', (string) $category->id)['started'],
            'agent' => $this->expectedRow('2026-03-20', '2026-03-27', 'agent', (string) $agent->id)['handled'],
        ];

        $widget->delete();                 // soft delete: still named
        $category->delete();               // soft delete
        $agent->delete();                  // the account is gone: conversations lose their assignee, the rollup rows do not

        $widgets = collect($this->fetch('breakdown', ['from' => '2026-03-20', 'to' => '2026-03-27', 'by' => 'widget'])['rows']);
        $categories = collect($this->fetch('breakdown', ['from' => '2026-03-20', 'to' => '2026-03-27', 'by' => 'category'])['rows']);
        $agents = collect($this->fetch('breakdown', ['from' => '2026-03-20', 'to' => '2026-03-27', 'by' => 'agent'])['rows']);

        $this->assertSame($before['widget'], $widgets->firstWhere('key', $widget->ulid)['kpis']['started']);
        $this->assertTrue($widgets->firstWhere('key', $widget->ulid)['deleted']);
        $this->assertSame('Shop', $widgets->firstWhere('key', $widget->ulid)['label']);
        $this->assertSame($before['category'], $categories->firstWhere('key', $category->ulid)['kpis']['started']);
        $this->assertTrue($categories->firstWhere('key', $category->ulid)['deleted']);

        $gone = $agents->firstWhere('key', (string) $agent->id);
        $this->assertSame($before['agent'], $gone['kpis']['handled']);
        $this->assertTrue($gone['deleted']);
        $this->assertSame('Deleted account', $gone['label']);

        // And the totals did not move.
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27')['started'], $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27'])['current']['started']);
    }

    public function test_the_heatmap_rebuckets_the_instants_into_the_viewers_time_zone(): void
    {
        foreach (['UTC', 'Europe/Berlin', 'Asia/Kolkata', 'America/Los_Angeles'] as $zone) {
            $data = $this->fetch('heatmap', ['from' => '2026-03-20', 'to' => '2026-03-31', 'tz' => $zone, 'metric' => 'started']);
            $expected = array_fill(0, 7, array_fill(0, 24, 0));

            foreach (Conversation::query()->where('type', 'live')->get() as $conversation) {
                $local = $conversation->created_at->clone()->setTimezone($zone);
                $at = $conversation->created_at->getTimestamp();

                // The range is the application time zone's days (UTC here): 2026-03-20 00:00Z to 2026-04-01 00:00Z.
                if ($at >= strtotime('2026-03-20 00:00:00 UTC') && $at < strtotime('2026-04-01 00:00:00 UTC')) {
                    $expected[(int) $local->format('N') - 1][(int) $local->format('G')]++;
                }
            }

            $this->assertSame($expected, $data['matrix'], $zone);
            $this->assertSame($zone, $data['timezone']);
            $this->assertSame(array_sum(array_merge(...$expected)), $data['total']);
            $this->assertSame(max(array_merge(...$expected)), $data['max']);
        }
    }

    public function test_an_agents_heatmap_is_about_the_chats_they_accepted(): void
    {
        $agent = $this->dataset->agents[0];
        $data = $this->fetch('heatmap', ['from' => '2026-03-20', 'to' => '2026-03-31'], $agent);

        $this->assertSame('claimed', $data['metric']);
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-31', 'agent', (string) $agent->id)['handled'] + $this->expectedRow('2026-03-20', '2026-03-31', 'agent', (string) $agent->id)['reclaimed'], $data['total']);
    }

    public function test_the_ratings_report_has_the_distribution_and_for_admins_the_latest_comments(): void
    {
        $data = $this->fetch('ratings', ['from' => '2026-03-20', 'to' => '2026-03-31']);
        $expected = $this->expectedRow('2026-03-20', '2026-03-31');

        $this->assertSame($expected['rating_count'], $data['ratings']['count']);
        $this->assertSame([$expected['rating_1'], $expected['rating_2'], $expected['rating_3'], $expected['rating_4'], $expected['rating_5']], $data['ratings']['distribution']);
        $this->assertLessThanOrEqual(20, count($data['recent']));
        $this->assertNotEmpty($data['recent']);

        $mine = $this->fetch('ratings', ['from' => '2026-03-20', 'to' => '2026-03-31'], $this->dataset->agents[0]);
        $this->assertSame([], $mine['recent'], 'an agent gets numbers about their own chats, never the visitors\' words');
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-31', 'agent', (string) $this->dataset->agents[0]->id)['rating_count'], $mine['ratings']['count']);
    }

    public function test_the_whatsapp_report_is_the_whatsapp_dimension(): void
    {
        $data = $this->fetch('whatsapp', ['from' => '2026-03-20', 'to' => '2026-03-27', 'interval' => 'day']);
        $expected = $this->expectedRow('2026-03-20', '2026-03-27', 'whatsapp');

        $this->assertSame($expected['wa_chats_new'], $data['current']['chats']);
        $this->assertSame($expected['wa_chats_linked'], $data['current']['linkedChats']);
        $this->assertSame($expected['wa_inbound'], $data['current']['inbound']);
        $this->assertSame($expected['wa_outbound'], $data['current']['outbound']);
        $this->assertSame($expected['wa_response_count'], $data['current']['responseCount']);
        $this->assertEqualsWithDelta($this->ratio($expected['wa_chats_linked'], $expected['wa_chats_new']), $data['current']['linkedShare'], 1e-9);
        $this->assertCount(8, $data['series']);
        $this->assertSame($expected['wa_inbound'], array_sum(array_column($data['series'], 'inbound')));
    }

    public function test_a_day_nobody_rolled_up_yet_is_computed_on_the_spot(): void
    {
        DB::table('analytics_daily')->where('date', '2026-03-24')->delete();

        $data = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27']);

        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27')['started'], $data['current']['started']);
        $this->assertSame(0, $data['meta']['missingDays']);
        $this->assertSame(0, DB::table('analytics_daily')->where('date', '2026-03-24')->count(), 'a GET never writes');
    }

    public function test_beyond_the_live_fill_limit_missing_days_are_flagged_not_computed(): void
    {
        config(['analytics.live_fill_days' => 2]);
        DB::table('analytics_daily')->whereBetween('date', ['2026-03-21', '2026-03-25'])->delete();

        $data = $this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27']);

        $this->assertSame(3, $data['meta']['missingDays']);
        $this->assertSame('2026-03-27', $data['meta']['rolledUpTo']);
        $this->assertFalse($data['meta']['live']);
    }

    public function test_a_changed_time_zone_is_reported(): void
    {
        DB::table('analytics_daily')->where('date', '2026-03-22')->update(['tz' => 'Europe/Berlin']);

        $this->assertTrue($this->fetch('overview', ['from' => '2026-03-20', 'to' => '2026-03-27'])['meta']['timezoneChanged']);
    }

    public function test_the_widget_names_exist_for_the_filters(): void
    {
        $this->assertSame(2, Widget::query()->count());
        $this->assertSame(3, Category::query()->count());
    }
}
