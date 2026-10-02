<?php

namespace Tests\Unit\Analytics;

use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsMetric;
use App\Domain\Analytics\Support\Buckets;
use App\Domain\Analytics\Support\CsvCell;
use App\Domain\Analytics\Support\Rows;
use PHPUnit\Framework\TestCase;

class AnalyticsMetricTest extends TestCase
{
    /**
     * @param  array<string, int>  $values
     * @return array<string, int>
     */
    private function row(array $values): array
    {
        return array_merge(Rows::zero(), $values);
    }

    public function test_an_average_is_the_sum_over_the_samples_and_nothing_to_average_is_null(): void
    {
        $row = $this->row(['wait_sum_s' => 90, 'wait_count' => 4, 'rating_sum' => 13, 'rating_count' => 3, 'msgs_sum' => 50, 'msgs_count' => 4]);

        $this->assertSame(22.5, AnalyticsMetric::WaitAvg->compute($row));
        $this->assertEqualsWithDelta(13 / 3, AnalyticsMetric::RatingAvg->compute($row), 1e-12);
        $this->assertSame(12.5, AnalyticsMetric::MessagesPerChat->compute($row));
        $this->assertNull(AnalyticsMetric::FirstResponseAvg->compute($row));
        $this->assertNull(AnalyticsMetric::HandlingAvg->compute($this->row([])));
        $this->assertNull(AnalyticsMetric::OfflineResponseAvg->compute($this->row(['offline_response_sum_s' => 100])));
    }

    public function test_the_rates(): void
    {
        $this->assertSame(0.75, AnalyticsMetric::AnswerRate->compute($this->row(['handled' => 3, 'missed' => 1])));
        $this->assertNull(AnalyticsMetric::AnswerRate->compute($this->row([])));
        $this->assertSame(0.5, AnalyticsMetric::OfferAcceptRate->compute($this->row(['handled' => 1, 'reclaimed' => 1, 'offers' => 4])));
        $this->assertSame(1.0, AnalyticsMetric::OfferAcceptRate->compute($this->row(['handled' => 5, 'offers' => 2])), 'capped at 1: an admin may claim a chat nobody offered them');
        $this->assertNull(AnalyticsMetric::OfferAcceptRate->compute($this->row(['handled' => 5])));
    }

    public function test_closed_is_the_sum_of_its_reasons_and_cancelled_is_one_of_them(): void
    {
        $row = $this->row(['closed_rated' => 1, 'closed_skipped' => 2, 'closed_idle' => 3, 'closed_timeout' => 4, 'closed_system' => 5, 'closed_cancelled' => 6]);

        $this->assertSame(21.0, AnalyticsMetric::Closed->compute($row));
        $this->assertSame(6.0, AnalyticsMetric::Cancelled->compute($row));
    }

    public function test_units_and_the_agent_applicability_are_what_the_docs_say(): void
    {
        $this->assertSame('seconds', AnalyticsMetric::WaitAvg->unit());
        $this->assertSame('seconds', AnalyticsMetric::OfflineResponseAvg->unit());
        $this->assertSame('score', AnalyticsMetric::RatingAvg->unit());
        $this->assertSame('ratio', AnalyticsMetric::AnswerRate->unit());
        $this->assertSame('count', AnalyticsMetric::Started->unit());

        $notForAnAgent = array_values(array_map(
            fn (AnalyticsMetric $metric): string => $metric->value,
            array_filter(AnalyticsMetric::cases(), fn (AnalyticsMetric $metric): bool => ! $metric->forAgent()),
        ));

        $this->assertEqualsCanonicalizing(['started', 'missed', 'cancelled', 'closed', 'answer_rate', 'queue_peak', 'offline_created', 'offline_closed'], $notForAnAgent);
    }

    public function test_every_metric_computes_on_an_empty_row_without_error(): void
    {
        foreach (AnalyticsMetric::cases() as $metric) {
            $value = $metric->compute(Rows::zero());

            $this->assertTrue($value === null || $value === 0.0, $metric->value);
        }

        $this->assertCount(count(AnalyticsMetric::cases()), array_unique(AnalyticsMetric::values()));
    }

    public function test_rows_add_counters_and_max_the_maxima(): void
    {
        $a = $this->row(['started' => 2, 'wait_sum_s' => 10, 'wait_max_s' => 8, 'peak_concurrent' => 3]);
        $b = $this->row(['started' => 5, 'wait_sum_s' => 1, 'wait_max_s' => 4, 'peak_concurrent' => 9]);
        $sum = Rows::sum([$a, $b]);

        $this->assertSame(7, $sum['started']);
        $this->assertSame(11, $sum['wait_sum_s']);
        $this->assertSame(8, $sum['wait_max_s']);
        $this->assertSame(9, $sum['peak_concurrent']);
        $this->assertSame(array_keys(Rows::zero()), array_keys($sum));
        $this->assertSame(0, Rows::sum([])['started']);
        $this->assertSame(['started' => 3] + Rows::zero(), ['started' => 3] + Rows::of(['started' => '3', 'unknown' => 9]));
    }

    public function test_the_registry_lists_every_column_once_and_knows_its_maxima(): void
    {
        $all = AnalyticsColumns::all();

        $this->assertSame($all, array_values(array_unique($all)));
        $this->assertTrue(AnalyticsColumns::isMaximum('wait_max_s'));
        $this->assertFalse(AnalyticsColumns::isMaximum('wait_sum_s'));
        $this->assertSame([...AnalyticsColumns::CHAT_COUNTERS, ...AnalyticsColumns::WHATSAPP_COUNTERS], AnalyticsColumns::COUNTERS);
    }

    public function test_buckets_are_the_first_day_of_the_day_the_iso_week_or_the_month(): void
    {
        $this->assertSame('2026-03-20', Buckets::start('2026-03-20', 'day'));
        $this->assertSame('2026-03-16', Buckets::start('2026-03-20', 'week'));    // a Friday
        $this->assertSame('2026-03-16', Buckets::start('2026-03-16', 'week'));    // the Monday itself
        $this->assertSame('2026-03-23', Buckets::start('2026-03-29', 'week'));    // a Sunday belongs to the week before
        $this->assertSame('2025-12-29', Buckets::start('2026-01-01', 'week'));    // across the year
        $this->assertSame('2026-03-01', Buckets::start('2026-03-31', 'month'));
        $this->assertSame('day', Buckets::automatic(62));
        $this->assertSame('week', Buckets::automatic(63));
        $this->assertSame('week', Buckets::automatic(540));
        $this->assertSame('month', Buckets::automatic(541));
    }

    public function test_csv_cells_that_look_like_formulas_are_quoted_and_numbers_are_not_touched(): void
    {
        foreach (['=1+1', '+1', '-1', '@x', "\tx", "\rx"] as $cell) {
            $this->assertSame("'".$cell, CsvCell::safe($cell));
        }

        $this->assertSame('plain', CsvCell::safe('plain'));
        $this->assertSame('a=b', CsvCell::safe('a=b'));
        $this->assertSame('', CsvCell::safe(''));
        $this->assertSame(-5, CsvCell::safe(-5));
        $this->assertSame('true', CsvCell::safe(true));
        $this->assertNull(CsvCell::safe(null));
    }
}
