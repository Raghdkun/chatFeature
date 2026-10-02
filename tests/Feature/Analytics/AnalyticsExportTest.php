<?php

namespace Tests\Feature\Analytics;

use App\Domain\Analytics\AnalyticsColumns;
use App\Models\Widget;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\Support\InteractsWithAnalytics;
use Tests\TestCase;

class AnalyticsExportTest extends TestCase
{
    use InteractsWithAnalytics, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->seedAnalytics();
    }

    /**
     * @return list<list<string|null>>
     */
    private function csv(string $query = 'from=2026-03-20&to=2026-03-27&format=csv'): array
    {
        $response = $this->actingAs($this->dataset->admin, 'sanctum')->get('/api/v1/analytics/export?'.$query);
        $response->assertOk();

        $this->assertStringStartsWith('text/csv', (string) $response->headers->get('Content-Type'));
        $this->assertStringContainsString('attachment; filename="analytics-', (string) $response->headers->get('Content-Disposition'));
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
        $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));

        $lines = [];
        $handle = fopen('php://memory', 'r+');
        fwrite($handle, $response->streamedContent());
        rewind($handle);

        while (($row = fgetcsv($handle, 0, ',', '"', '')) !== false) {
            $lines[] = $row;
        }

        return $lines;
    }

    public function test_the_header_and_the_rows_are_the_stored_days(): void
    {
        $lines = $this->csv();
        $header = array_shift($lines);

        $this->assertSame(['date', 'dimension', 'key', 'label', 'timezone', ...AnalyticsColumns::all()], $header);
        $this->assertGreaterThan(40, count($lines));

        $totals = array_values(array_filter($lines, fn (array $line) => $line[1] === 'total'));
        $this->assertCount(8, $totals, 'one total row per day');
        $this->assertSame(['2026-03-20', '2026-03-21'], array_slice(array_column($totals, 0), 0, 2));

        $startedColumn = array_search('started', $header, true);
        $this->assertSame($this->expectedRow('2026-03-20', '2026-03-27')['started'], array_sum(array_map(fn ($line) => (int) $line[$startedColumn], $totals)));
        $this->assertSame(array_fill(0, count($lines), count($header)), array_map('count', $lines), 'every line has every column');
        $this->assertContains('whatsapp', array_column($lines, 1));
        $this->assertContains('agent', array_column($lines, 1));
    }

    public function test_a_filter_exports_only_its_row(): void
    {
        $widget = $this->dataset->widgets[0];
        $lines = $this->csv('from=2026-03-20&to=2026-03-27&format=csv&widget='.$widget->ulid);
        array_shift($lines);

        $this->assertNotEmpty($lines);
        $this->assertSame(['widget'], array_values(array_unique(array_column($lines, 1))));
        $this->assertSame([(string) $widget->id], array_values(array_unique(array_column($lines, 2))));
        $this->assertSame([$widget->name], array_values(array_unique(array_column($lines, 3))));
    }

    public function test_names_that_look_like_formulas_are_quoted(): void
    {
        $evil = Widget::factory()->create(['name' => '=HYPERLINK("http://evil.test","click")']);
        $plus = Widget::factory()->create(['name' => '+SUM(1+1)']);
        $at = Widget::factory()->create(['name' => '@cmd']);
        $dash = Widget::factory()->create(['name' => '-2+3']);

        foreach ([$evil, $plus, $at, $dash] as $widget) {
            DB::table('analytics_daily')->insert(['date' => '2026-03-20', 'dimension' => 'widget', 'dimension_key' => (string) $widget->id, 'tz' => 'UTC', 'started' => 1]);
        }

        $lines = $this->csv('from=2026-03-20&to=2026-03-20&format=csv&widget='.$evil->ulid);
        $labels = array_column($this->csv('from=2026-03-20&to=2026-03-20&format=csv'), 3);

        $this->assertContains("'=HYPERLINK(\"http://evil.test\",\"click\")", $labels);
        $this->assertContains("'+SUM(1+1)", $labels);
        $this->assertContains("'@cmd", $labels);
        $this->assertContains("'-2+3", $labels);
        $this->assertNotContains('=HYPERLINK("http://evil.test","click")', $labels);
        $this->assertCount(2, $lines, 'the filtered export is the header and one row');
    }

    public function test_today_is_the_live_computation_and_missing_days_are_reported(): void
    {
        DB::table('analytics_daily')->where('date', '2026-03-22')->delete();

        $response = $this->actingAs($this->dataset->admin, 'sanctum')->get('/api/v1/analytics/export?from=2026-03-20&to=2026-03-27&format=csv');

        $this->assertSame('1', $response->headers->get('X-Analytics-Missing-Days'));
        $this->assertStringNotContainsString('2026-03-22', $response->streamedContent());
    }

    public function test_the_export_range_is_validated_like_the_reports(): void
    {
        $this->actingAs($this->dataset->admin, 'sanctum')->getJson('/api/v1/analytics/export?from=2020-01-01&to=2026-01-01&format=csv')->assertStatus(422);
    }
}
