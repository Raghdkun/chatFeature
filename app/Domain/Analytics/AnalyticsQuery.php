<?php

namespace App\Domain\Analytics;

use App\Data\Analytics\AnalyticsRangeData;
use Carbon\CarbonImmutable;

/**
 * A validated analytics request: the scope (decided by the caller's role), the inclusive range of application-time-zone days, whether to
 * compare with the previous range, and the viewer's time zone (only the heatmap uses it: days are always counted in `timezone`).
 */
final class AnalyticsQuery
{
    public function __construct(
        public readonly AnalyticsScope $scope,
        public readonly string $from,
        public readonly string $to,
        public readonly bool $compare,
        public readonly string $timezone,
        public readonly string $viewerTimezone,
        public readonly string $today,
    ) {}

    public function days(): int
    {
        return $this->spanDays($this->from, $this->to);
    }

    public function range(): AnalyticsRangeData
    {
        return new AnalyticsRangeData($this->from, $this->to, $this->days());
    }

    /** The equally long range that ends the day before this one starts. */
    public function previousRange(): AnalyticsRangeData
    {
        $days = $this->days();
        $end = CarbonImmutable::createFromFormat('!Y-m-d', $this->from, 'UTC')->subDay();
        $start = $end->subDays($days - 1);

        return new AnalyticsRangeData($start->format('Y-m-d'), $end->format('Y-m-d'), $days);
    }

    public function includesToday(?string $from = null, ?string $to = null): bool
    {
        return ($from ?? $this->from) <= $this->today && $this->today <= ($to ?? $this->to);
    }

    /**
     * @param  array<string, mixed>  $extra
     * @return array<string, mixed>
     */
    public function cacheParts(array $extra = []): array
    {
        return [
            'scope' => $this->scope->signature(),
            'from' => $this->from,
            'to' => $this->to,
            'compare' => $this->compare,
            'tz' => $this->timezone,
            'viewer' => $this->viewerTimezone,
        ] + $extra;
    }

    private function spanDays(string $from, string $to): int
    {
        return (int) CarbonImmutable::createFromFormat('!Y-m-d', $from, 'UTC')->diffInDays(CarbonImmutable::createFromFormat('!Y-m-d', $to, 'UTC')) + 1;
    }
}
