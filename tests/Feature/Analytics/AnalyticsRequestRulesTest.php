<?php

namespace Tests\Feature\Analytics;

use App\Domain\Settings\Facades\Settings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

/**
 * Ranges are validated and clamped, closed lists are strict, and the time zone the days are counted in is the application setting.
 */
class AnalyticsRequestRulesTest extends TestCase
{
    use InteractsWithAnalytics, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics(perDay: 2);
    }

    /**
     * @param  array<string, mixed>  $query
     */
    private function overview(array $query): TestResponse
    {
        return $this->actingAs($this->dataset->admin, 'sanctum')->getJson('/api/v1/analytics/overview?'.http_build_query($query));
    }

    public function test_the_default_range_is_the_last_thirty_days_ending_today(): void
    {
        $range = $this->overview([])->assertOk()->json('data.range');
        $today = now()->format('Y-m-d');

        $this->assertSame($today, $range['to']);
        $this->assertSame(30, $range['days']);
        $this->assertSame(now()->subDays(29)->format('Y-m-d'), $range['from']);
    }

    public function test_the_end_is_clamped_to_today(): void
    {
        $range = $this->overview(['from' => '2026-09-25', 'to' => '2099-12-31'])->assertOk()->json('data.range');

        $this->assertSame(now()->format('Y-m-d'), $range['to']);
    }

    public function test_a_range_that_starts_after_it_ends_or_is_too_long_is_refused(): void
    {
        $this->overview(['from' => '2026-03-27', 'to' => '2026-03-20'])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->overview(['from' => '2026-09-01', 'to' => '2026-08-01'])->assertStatus(422);
        $this->overview(['from' => '2024-09-29', 'to' => '2026-09-30'])->assertStatus(422);   // 732 days
        $this->overview(['from' => '2024-09-30', 'to' => '2026-09-30'])->assertOk();           // 731 days: the longest allowed
    }

    public function test_dates_must_be_real_dates(): void
    {
        foreach (['2026-02-30', '2026-13-01', 'yesterday', '26-03-20', '2026/03/20', '2026-03-20T00:00:00Z', '2026-3-2'] as $bad) {
            $this->overview(['from' => $bad, 'to' => '2026-03-27'])->assertStatus(422);
            $this->overview(['from' => '2026-03-20', 'to' => $bad])->assertStatus(422);
        }
    }

    public function test_the_closed_lists_are_strict(): void
    {
        $get = fn (string $path) => $this->actingAs($this->dataset->admin, 'sanctum')->getJson('/api/v1/analytics/'.$path);

        $get('timeseries?metric=started&interval=hour')->assertStatus(422);
        $get('timeseries?metric=nonsense')->assertStatus(422);
        $get('timeseries')->assertStatus(422);                                             // a metric is required
        $get('timeseries?metric=started,handled,missed,ended,closed,offers,res_idle')->assertStatus(422); // seven
        $get('timeseries?metric=started&interval=month&from=2026-03-01&to=2026-03-31')->assertOk();
        $get('breakdown')->assertStatus(422);
        $get('breakdown?by=visitor')->assertStatus(422);
        $get('heatmap?metric=messages')->assertStatus(422);
        $get('heatmap?tz=Mars/Base')->assertStatus(422);
        $get('export?format=json')->assertStatus(422);
        $get('overview?widget=not-a-ulid')->assertStatus(422);
        $get('overview?widget='.str_repeat('A', 26))->assertStatus(422);                    // a well-formed ulid nobody has
        $get('overview?agent=abc')->assertStatus(422);
        $get('overview?agent[]=1')->assertStatus(422);
    }

    public function test_the_days_are_counted_in_the_application_time_zone_setting(): void
    {
        Settings::set('app.timezone', 'Europe/Berlin');
        $berlinToday = now()->setTimezone('Europe/Berlin')->format('Y-m-d');

        $meta = $this->overview(['from' => $berlinToday, 'to' => $berlinToday])->assertOk()->json('data.meta');

        $this->assertSame('Europe/Berlin', $meta['timezone']);
        $this->assertSame($berlinToday, $meta['today']);
        $this->assertTrue($meta['live']);
    }
}
