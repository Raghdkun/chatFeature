<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\Collection\Collectors\ClaimCollector;
use App\Domain\Analytics\Collection\Collectors\ConversationStartCollector;
use App\Domain\Analytics\Collection\Collectors\LifecycleEventCollector;
use App\Domain\Analytics\Collection\Collectors\MessageCollector;
use App\Domain\Analytics\Collection\Collectors\OutcomeCollector;
use App\Domain\Analytics\Collection\Collectors\RatingCollector;
use App\Domain\Analytics\Collection\Collectors\ResponseCollector;
use App\Domain\Analytics\Collection\Collectors\SweepCollector;
use App\Domain\Analytics\Collection\Collectors\WhatsAppCollector;
use App\Domain\Analytics\Support\DayWindow;

/**
 * THE implementation of every analytics number: reads the raw tables for one calendar day of a time zone and returns the day's
 * {@see DayMetrics}. The rollup stores the result; today's live numbers are this same call, so a stored day and a live day can never drift
 * apart. It writes nothing and is safe to call at any time.
 */
final class MetricCalculator
{
    public function __construct(
        private readonly ConversationStartCollector $starts,
        private readonly ClaimCollector $claims,
        private readonly LifecycleEventCollector $lifecycle,
        private readonly OutcomeCollector $outcomes,
        private readonly RatingCollector $ratings,
        private readonly MessageCollector $messages,
        private readonly ResponseCollector $responses,
        private readonly SweepCollector $sweep,
        private readonly WhatsAppCollector $whatsApp,
    ) {}

    /**
     * @param  bool  $withWhatsApp  false when the day's WhatsApp rows are not to be recomputed (the raw messages may have been pruned)
     */
    public function forDay(string $date, string $timezone, bool $withWhatsApp = true): DayMetrics
    {
        $window = DayWindow::forDate($date, $timezone);
        $context = new DayContext($window, new DayMetrics, new ClaimIndex, now()->getTimestamp());

        foreach ([$this->starts, $this->claims, $this->lifecycle, $this->outcomes, $this->ratings, $this->messages, $this->responses, $this->sweep] as $collector) {
            $collector->collect($context);
        }

        if ($withWhatsApp) {
            $this->whatsApp->collect($context);
        }

        return $context->metrics;
    }
}
