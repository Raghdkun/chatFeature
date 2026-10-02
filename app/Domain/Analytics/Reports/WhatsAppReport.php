<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsWhatsAppData;
use App\Data\Analytics\AnalyticsWhatsAppPointData;
use App\Data\Analytics\AnalyticsWhatsAppTotalsData;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsMetric;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\Buckets;
use App\Domain\Analytics\Support\Rows;
use Carbon\CarbonImmutable;

/**
 * `GET /analytics/whatsapp` (administrators only, enforced by the route AND the controller): WhatsApp chats, the share linked to a widget
 * visitor by a hand-off, inbound and outbound messages and the response time. These rows never mix with chat rows and no agent endpoint
 * reads the `whatsapp` dimension.
 */
final class WhatsAppReport
{
    public function __construct(private readonly RowReader $reader) {}

    public function handle(AnalyticsQuery $query, string $interval): AnalyticsWhatsAppData
    {
        $result = $this->reader->read(AnalyticsColumns::WHATSAPP, '', $query->from, $query->to);
        $previousRange = null;
        $previousTotals = null;
        $previousMissing = 0;

        if ($query->compare) {
            $previousRange = $query->previousRange();
            $previous = $this->reader->read(AnalyticsColumns::WHATSAPP, '', $previousRange->from, $previousRange->to);
            $previousTotals = $this->totals($previous->sum($previousRange->from, $previousRange->to));
            $previousMissing = $previous->missingDays;
        }

        /** @var array<string, array<string, int>> $buckets */
        $buckets = [];

        for ($day = CarbonImmutable::createFromFormat('!Y-m-d', $query->from, 'UTC'); $day->format('Y-m-d') <= $query->to; $day = $day->addDay()) {
            $date = $day->format('Y-m-d');
            $bucket = Buckets::start($date, $interval);
            $buckets[$bucket] = Rows::merge($buckets[$bucket] ?? Rows::zero(), $result->row($date));
        }

        $series = [];

        foreach ($buckets as $date => $row) {
            $series[] = new AnalyticsWhatsAppPointData(
                (string) $date,
                $row['wa_chats_new'],
                $row['wa_inbound'],
                $row['wa_outbound'],
                AnalyticsMetric::ratio($row['wa_response_sum_s'], $row['wa_response_count']),
            );
        }

        return new AnalyticsWhatsAppData(
            range: $query->range(),
            previousRange: $previousRange,
            interval: $interval,
            current: $this->totals($result->sum($query->from, $query->to)),
            previous: $previousTotals,
            series: $series,
            meta: MetaFactory::fromResult($query, $result, $previousMissing),
        );
    }

    /**
     * @param  array<string, int>  $row
     */
    private function totals(array $row): AnalyticsWhatsAppTotalsData
    {
        return new AnalyticsWhatsAppTotalsData(
            chats: $row['wa_chats_new'],
            linkedChats: $row['wa_chats_linked'],
            linkedShare: AnalyticsMetric::ratio($row['wa_chats_linked'], $row['wa_chats_new']),
            inbound: $row['wa_inbound'],
            outbound: $row['wa_outbound'],
            averageResponseSeconds: AnalyticsMetric::ratio($row['wa_response_sum_s'], $row['wa_response_count']),
            responseCount: $row['wa_response_count'],
        );
    }
}
