<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\AnalyticsColumns;

/**
 * Where one fact is counted: always in `total`, and in the `widget` and `category` rows of the conversation it belongs to (a chat
 * without a topic is category `0`), and, when a person is responsible for it, in that agent's row (an agent we cannot name, because the
 * account was deleted or the event carries none, is agent `0`). The agent dimension is only used for the metrics an agent causes.
 */
final class Attribution
{
    private function __construct(
        public readonly int $widget,
        public readonly int $category,
        public readonly ?int $agent,
        public readonly bool $withAgent,
    ) {}

    public static function conversation(int $widgetId, ?int $categoryId): self
    {
        return new self($widgetId, $categoryId ?? 0, null, false);
    }

    /** The same fact, also counted for `$agentId` (`null` = nobody we can name: agent `0`). */
    public function byAgent(?int $agentId): self
    {
        return new self($this->widget, $this->category, $agentId ?? 0, true);
    }

    /**
     * @return list<array{0: string, 1: string}> (dimension, key)
     */
    public function targets(): array
    {
        $targets = [
            [AnalyticsColumns::TOTAL, ''],
            [AnalyticsColumns::WIDGET, (string) $this->widget],
            [AnalyticsColumns::CATEGORY, (string) $this->category],
        ];

        if ($this->withAgent) {
            $targets[] = [AnalyticsColumns::AGENT, (string) ($this->agent ?? 0)];
        }

        return $targets;
    }
}
