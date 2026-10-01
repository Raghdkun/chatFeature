<?php

namespace App\Domain\Chat\Services;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Data\RoutingWaveData;
use App\Domain\Widgets\Enums\RoutingStatus;
use App\Models\Widget;

/**
 * Who a new chat is offered to, and when: the widget's `config.routing.waves` (default: `online` agents at once, `away` agents
 * after `chat.offer_wave_delay_seconds`, docs/contracts/widget-config.md). Wave `n` offers the chat to every available agent
 * whose presence is in the statuses of waves `1..n` that has not been offered it yet, so an agent who turned `online` in the
 * meantime is not skipped. `offline` is never offered in P4 (waking offline agents by push is P5).
 */
final readonly class RoutingPlan
{
    /**
     * @param  list<array{after: int, statuses: list<PresenceStatus>}>  $waves  ordered by `after`
     */
    private function __construct(public array $waves) {}

    public static function forWidget(Widget $widget): self
    {
        $configured = [];

        foreach (app(WidgetConfigValidator::class)->hydrate($widget->config)->routing->waves as $wave) {
            $configured[] = ['after' => max(0, $wave->afterSeconds), 'statuses' => self::presence($wave)];
        }

        if ($configured === []) {
            return self::default();
        }

        usort($configured, static fn (array $a, array $b): int => $a['after'] <=> $b['after']);

        return new self(array_slice($configured, 0, 5));
    }

    /** Online agents first, away agents after the configured delay. */
    public static function default(): self
    {
        return new self([
            ['after' => 0, 'statuses' => [PresenceStatus::Online]],
            ['after' => max(0, settings()->int('chat.offer_wave_delay_seconds', 20)), 'statuses' => [PresenceStatus::Away]],
        ]);
    }

    public function waveCount(): int
    {
        return count($this->waves);
    }

    /** Seconds after queueing at which wave `$wave` (1-based) is offered. */
    public function delayFor(int $wave): int
    {
        return $this->waves[$wave - 1]['after'] ?? 0;
    }

    /**
     * The presence statuses that may be offered the chat by wave `$wave` (1-based): the statuses of waves `1..$wave`.
     *
     * @return list<PresenceStatus>
     */
    public function statusesUpTo(int $wave): array
    {
        $statuses = [];

        foreach (array_slice($this->waves, 0, max(0, $wave)) as $entry) {
            foreach ($entry['statuses'] as $status) {
                $statuses[$status->value] = $status;
            }
        }

        return array_values($statuses);
    }

    /**
     * Every status any wave may offer to: when no agent in them is available, nobody can be offered the chat at all.
     *
     * @return list<PresenceStatus>
     */
    public function allStatuses(): array
    {
        return $this->statusesUpTo($this->waveCount());
    }

    /**
     * @return list<PresenceStatus>
     */
    private static function presence(RoutingWaveData $wave): array
    {
        $statuses = [];

        foreach ($wave->statuses as $status) {
            $presence = match ($status) {
                RoutingStatus::Online => PresenceStatus::Online,
                RoutingStatus::Away => PresenceStatus::Away,
                default => null,
            };

            if ($presence !== null) {
                $statuses[] = $presence;
            }
        }

        return $statuses;
    }
}
