<?php

namespace App\Domain\Analytics;

/**
 * A metric a time series can show: derived from the summed columns of a range (never from stored averages). `unit()` tells the client how to
 * format it, `forAgent()` whether it can belong to one agent (the numbers an agent causes; see `AnalyticsScope`).
 */
enum AnalyticsMetric: string
{
    case Started = 'started';
    case Handled = 'handled';
    case Reclaimed = 'reclaimed';
    case Transferred = 'transferred';
    case Missed = 'missed';
    case Cancelled = 'cancelled';
    case Ended = 'ended';
    case Closed = 'closed';
    case AnswerRate = 'answer_rate';
    case WaitAvg = 'wait_avg';
    case WaitMax = 'wait_max';
    case FirstResponseAvg = 'frt_avg';
    case FirstResponseMax = 'frt_max';
    case HandlingAvg = 'handling_avg';
    case HandlingMax = 'handling_max';
    case RatingAvg = 'rating_avg';
    case RatingCount = 'rating_count';
    case MessagesVisitor = 'messages_visitor';
    case MessagesAgent = 'messages_agent';
    case MessagesPerChat = 'messages_per_chat';
    case PeakConcurrent = 'peak_concurrent';
    case QueuePeak = 'queue_peak';
    case OfflineCreated = 'offline_created';
    case OfflineAnswered = 'offline_answered';
    case OfflineClosed = 'offline_closed';
    case OfflineResponseAvg = 'offline_response_avg';
    case Offers = 'offers';
    case OfferAcceptRate = 'offer_accept_rate';
    case ResolvedByVisitor = 'res_visitor';
    case ResolvedByAgent = 'res_agent';
    case ResolvedBySystem = 'res_system';
    case ResolvedIdle = 'res_idle';

    public function unit(): string
    {
        return match ($this) {
            self::AnswerRate, self::OfferAcceptRate => 'ratio',
            self::WaitAvg, self::WaitMax, self::FirstResponseAvg, self::FirstResponseMax, self::HandlingAvg, self::HandlingMax, self::OfflineResponseAvg => 'seconds',
            self::RatingAvg => 'score',
            default => 'count',
        };
    }

    /** Whether the metric makes sense for one agent's own row (a chat's start or its being missed has no agent). */
    public function forAgent(): bool
    {
        return ! in_array($this, [self::Started, self::Missed, self::Cancelled, self::Closed, self::AnswerRate, self::QueuePeak, self::OfflineCreated, self::OfflineClosed], true);
    }

    /**
     * @param  array<string, int>  $row  summed (counters) / maxed (maxima) columns of a range
     */
    public function compute(array $row): ?float
    {
        $get = static fn (string $column): int => $row[$column] ?? 0;

        return match ($this) {
            self::Started => (float) $get('started'),
            self::Handled => (float) $get('handled'),
            self::Reclaimed => (float) $get('reclaimed'),
            self::Transferred => (float) $get('transferred'),
            self::Missed => (float) $get('missed'),
            self::Cancelled => (float) $get('closed_cancelled'),
            self::Ended => (float) $get('ended'),
            self::Closed => (float) array_sum(array_map($get, ['closed_rated', 'closed_skipped', 'closed_idle', 'closed_timeout', 'closed_system', 'closed_cancelled'])),
            self::AnswerRate => self::ratio($get('handled'), $get('handled') + $get('missed')),
            self::WaitAvg => self::ratio($get('wait_sum_s'), $get('wait_count')),
            self::WaitMax => (float) $get('wait_max_s'),
            self::FirstResponseAvg => self::ratio($get('frt_sum_s'), $get('frt_count')),
            self::FirstResponseMax => (float) $get('frt_max_s'),
            self::HandlingAvg => self::ratio($get('handling_sum_s'), $get('handling_count')),
            self::HandlingMax => (float) $get('handling_max_s'),
            self::RatingAvg => self::ratio($get('rating_sum'), $get('rating_count')),
            self::RatingCount => (float) $get('rating_count'),
            self::MessagesVisitor => (float) $get('messages_visitor'),
            self::MessagesAgent => (float) $get('messages_agent'),
            self::MessagesPerChat => self::ratio($get('msgs_sum'), $get('msgs_count')),
            self::PeakConcurrent => (float) $get('peak_concurrent'),
            self::QueuePeak => (float) $get('queue_peak'),
            self::OfflineCreated => (float) $get('offline_created'),
            self::OfflineAnswered => (float) $get('offline_answered'),
            self::OfflineClosed => (float) $get('offline_closed'),
            self::OfflineResponseAvg => self::ratio($get('offline_response_sum_s'), $get('offline_answered')),
            self::Offers => (float) $get('offers'),
            self::OfferAcceptRate => self::ratio(min($get('handled') + $get('reclaimed'), $get('offers')), $get('offers')),
            self::ResolvedByVisitor => (float) $get('res_visitor'),
            self::ResolvedByAgent => (float) $get('res_agent'),
            self::ResolvedBySystem => (float) $get('res_system'),
            self::ResolvedIdle => (float) $get('res_idle'),
        };
    }

    /** `$numerator / $denominator`, `null` when there is nothing to divide by. */
    public static function ratio(int $numerator, int $denominator): ?float
    {
        return $denominator > 0 ? $numerator / $denominator : null;
    }

    /**
     * @return list<string>
     */
    public static function values(): array
    {
        return array_map(static fn (self $metric): string => $metric->value, self::cases());
    }
}
