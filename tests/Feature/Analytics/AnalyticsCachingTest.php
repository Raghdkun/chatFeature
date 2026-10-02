<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\Actions\RollupRange;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

/**
 * Reports are cached briefly per scope, a rollup run empties them, and the number of queries does not grow with the range or the data.
 */
class AnalyticsCachingTest extends TestCase
{
    use InteractsWithAnalytics, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics();
    }

    /**
     * @return list<string>
     */
    private function queriesOf(callable $call): array
    {
        DB::flushQueryLog();
        DB::enableQueryLog();
        $call();
        DB::disableQueryLog();

        return array_column(DB::getQueryLog(), 'query');
    }

    private function overview(User $as, string $query = 'from=2026-03-20&to=2026-03-27')
    {
        return $this->actingAs($as, 'sanctum')->getJson('/api/v1/analytics/overview?'.$query);
    }

    private function touchesAnalytics(array $queries): bool
    {
        return collect($queries)->contains(fn (string $sql) => str_contains($sql, 'analytics_daily') || str_contains($sql, 'analytics_slots'));
    }

    public function test_a_second_identical_request_does_not_touch_the_rollup_tables(): void
    {
        config(['analytics.past_report_ttl' => 600]);
        Cache::flush();

        $first = $this->queriesOf(fn () => $this->overview($this->dataset->admin)->assertOk());
        $second = $this->queriesOf(fn () => $this->overview($this->dataset->admin)->assertOk());

        $this->assertTrue($this->touchesAnalytics($first));
        $this->assertFalse($this->touchesAnalytics($second));
    }

    public function test_the_cache_key_holds_the_scope_so_an_agent_never_gets_the_administrators_answer(): void
    {
        config(['analytics.past_report_ttl' => 600]);
        Cache::flush();
        $agent = $this->dataset->agents[0];

        $admin = $this->overview($this->dataset->admin)->assertOk()->json('data');
        $mine = $this->overview($agent)->assertOk()->json('data');
        $other = $this->overview($this->dataset->agents[1])->assertOk()->json('data');

        $this->assertSame('total', $admin['scope']['dimension']);
        $this->assertSame((string) $agent->id, $mine['scope']['key']);
        $this->assertSame((string) $this->dataset->agents[1]->id, $other['scope']['key']);
        $this->assertNotSame($mine['current']['handled'], $other['current']['handled']);
        $this->assertSame($mine, $this->overview($agent)->json('data'), 'and a repeat is the same agent\'s own answer');
    }

    public function test_different_filters_and_ranges_are_different_entries(): void
    {
        config(['analytics.past_report_ttl' => 600]);
        Cache::flush();

        $a = $this->overview($this->dataset->admin, 'from=2026-03-20&to=2026-03-27')->json('data.current.started');
        $b = $this->overview($this->dataset->admin, 'from=2026-03-20&to=2026-03-22')->json('data.current.started');
        $c = $this->overview($this->dataset->admin, 'from=2026-03-20&to=2026-03-27&widget='.$this->dataset->widgets[0]->ulid)->json('data.current.started');

        $this->assertNotSame($a, $b);
        $this->assertNotSame($a, $c);
    }

    public function test_a_rollup_run_empties_the_report_cache(): void
    {
        config(['analytics.past_report_ttl' => 600]);
        Cache::flush();

        $this->overview($this->dataset->admin)->assertOk();
        $cached = $this->queriesOf(fn () => $this->overview($this->dataset->admin)->assertOk());
        app(RollupRange::class)->handle('2026-03-20', '2026-03-20', true);
        $after = $this->queriesOf(fn () => $this->overview($this->dataset->admin)->assertOk());

        $this->assertFalse($this->touchesAnalytics($cached));
        $this->assertTrue($this->touchesAnalytics($after));
    }

    public function test_with_the_caches_off_a_change_shows_at_once(): void
    {
        $before = $this->overview($this->dataset->admin)->json('data.current.started');
        DB::table('analytics_daily')->where('date', '2026-03-20')->where('dimension', 'total')->increment('started', 5);

        $this->assertSame($before + 5, $this->overview($this->dataset->admin)->json('data.current.started'));
    }

    public function test_the_query_count_does_not_grow_with_the_range(): void
    {
        $short = $this->queriesOf(fn () => $this->overview($this->dataset->admin, 'from=2026-03-26&to=2026-03-27&compare=1')->assertOk());
        $long = $this->queriesOf(fn () => $this->overview($this->dataset->admin, 'from=2026-03-20&to=2026-03-27&compare=1')->assertOk());

        $this->assertSame(count($short), count($long));
        $this->assertLessThanOrEqual(16, count($long), implode("\n", $long));
    }

    public function test_every_report_has_a_constant_query_budget(): void
    {
        $admin = $this->dataset->admin;
        $get = fn (string $path) => $this->actingAs($admin, 'sanctum')->getJson('/api/v1/analytics/'.$path)->assertOk();
        $range = 'from=2026-03-20&to=2026-03-27';

        $budgets = [
            "timeseries?{$range}&metric=started,handled,wait_avg,frt_avg&interval=day" => 10,
            "breakdown?{$range}&by=agent" => 14,
            "breakdown?{$range}&by=widget" => 14,
            "breakdown?{$range}&by=category" => 14,
            "heatmap?{$range}&tz=Europe/Berlin" => 12,
            "ratings?{$range}" => 16,
            "whatsapp?{$range}&compare=1" => 12,
        ];

        foreach ($budgets as $path => $limit) {
            $queries = $this->queriesOf(fn () => $get($path));
            $this->assertLessThanOrEqual($limit, count($queries), $path."\n".implode("\n", $queries));
        }
    }
}
