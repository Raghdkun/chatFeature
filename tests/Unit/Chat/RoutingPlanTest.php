<?php

namespace Tests\Unit\Chat;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Chat\Services\RoutingPlan;
use App\Models\Widget;
use Tests\TestCase;

/**
 * How a widget's routing waves become "who may be offered the chat when".
 */
class RoutingPlanTest extends TestCase
{
    /**
     * @param  list<array{afterSeconds: int, statuses: list<string>}>|null  $waves
     */
    private function widget(?array $waves): Widget
    {
        $widget = new Widget;
        $widget->config = $waves === null ? [] : ['routing' => ['waves' => $waves]];

        return $widget;
    }

    /**
     * @param  list<PresenceStatus>  $statuses
     * @return list<string>
     */
    private function values(array $statuses): array
    {
        return array_map(fn (PresenceStatus $status): string => $status->value, $statuses);
    }

    public function test_a_widget_without_routing_gets_the_default_waves(): void
    {
        $plan = RoutingPlan::forWidget($this->widget(null));

        $this->assertSame(2, $plan->waveCount());
        $this->assertSame([0, 20], [$plan->delayFor(1), $plan->delayFor(2)]);
        $this->assertSame(['online'], $this->values($plan->statusesUpTo(1)));
        $this->assertSame(['online', 'away'], $this->values($plan->statusesUpTo(2)));
        $this->assertSame(['online', 'away'], $this->values($plan->allStatuses()));
    }

    public function test_the_configured_waves_are_used_ordered_and_cumulative(): void
    {
        $plan = RoutingPlan::forWidget($this->widget([
            ['afterSeconds' => 30, 'statuses' => ['online', 'away']],
            ['afterSeconds' => 0, 'statuses' => ['online']],
            ['afterSeconds' => 10, 'statuses' => ['away']],
        ]));

        $this->assertSame(3, $plan->waveCount());
        $this->assertSame([0, 10, 30], [$plan->delayFor(1), $plan->delayFor(2), $plan->delayFor(3)]);
        $this->assertSame(['online'], $this->values($plan->statusesUpTo(1)));
        $this->assertSame(['online', 'away'], $this->values($plan->statusesUpTo(2)));
        $this->assertSame(['online', 'away'], $this->values($plan->statusesUpTo(3)));
        $this->assertSame([], $plan->statusesUpTo(0));
        $this->assertSame(0, $plan->delayFor(9), 'an unknown wave is due at once');
    }

    public function test_offline_is_never_offered_a_chat(): void
    {
        $plan = RoutingPlan::forWidget($this->widget([
            ['afterSeconds' => 0, 'statuses' => ['offline']],
            ['afterSeconds' => 5, 'statuses' => ['online', 'offline']],
        ]));

        $this->assertSame([], $this->values($plan->statusesUpTo(1)));
        $this->assertSame(['online'], $this->values($plan->allStatuses()));
    }

    public function test_at_most_five_waves_count(): void
    {
        $waves = array_map(fn (int $i): array => ['afterSeconds' => $i * 10, 'statuses' => ['online']], range(0, 7));

        $this->assertSame(5, RoutingPlan::forWidget($this->widget($waves))->waveCount());
    }
}
