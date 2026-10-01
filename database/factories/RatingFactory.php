<?php

namespace Database\Factories;

use App\Models\Conversation;
use App\Models\Rating;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Rating>
 */
class RatingFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'conversation_id' => Conversation::factory()->closed(),
            'score' => 5,
            'comment' => fake()->sentence(),
        ];
    }

    public function score(int $score): static
    {
        return $this->state(fn (): array => ['score' => $score]);
    }
}
