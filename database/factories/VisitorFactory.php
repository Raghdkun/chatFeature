<?php

namespace Database\Factories;

use App\Models\Visitor;
use App\Models\Widget;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Visitor>
 */
class VisitorFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => null,
            'widget_id' => Widget::factory(),
            'external_id' => null,
            'verified' => false,
            'name' => fake()->name(),
            'email' => fake()->unique()->safeEmail(),
            'phone' => null,
            'meta' => [],
            'first_seen_at' => now(),
            'last_seen_at' => now(),
        ];
    }

    /** A visitor who gave nothing about themselves. */
    public function anonymous(): static
    {
        return $this->state(fn (): array => ['name' => null, 'email' => null, 'phone' => null]);
    }

    /** A visitor the host site vouched for with a signed identity. */
    public function verified(?string $externalId = null): static
    {
        return $this->state(fn (): array => ['verified' => true, 'external_id' => $externalId ?? 'user-'.fake()->unique()->numberBetween(1000, 999999)]);
    }
}
