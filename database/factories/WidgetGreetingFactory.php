<?php

namespace Database\Factories;

use App\Models\WidgetGreeting;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<WidgetGreeting>
 */
class WidgetGreetingFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'body' => fake()->sentence(8),
            'agent_name' => fake()->firstName(),
            'agent_avatar_url' => null,
            'locale' => null,
            'weight' => 1,
            'is_active' => true,
            'sort_order' => 0,
        ];
    }

    public function inactive(): static
    {
        return $this->state(fn (): array => ['is_active' => false]);
    }

    public function locale(string $locale): static
    {
        return $this->state(fn (): array => ['locale' => $locale]);
    }
}
