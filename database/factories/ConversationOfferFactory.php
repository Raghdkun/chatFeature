<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\OfferResponse;
use App\Models\Conversation;
use App\Models\ConversationOffer;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * An open offer for a fresh agent, valid for 90 seconds.
 *
 * @extends Factory<ConversationOffer>
 */
class ConversationOfferFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'conversation_id' => Conversation::factory(),
            'user_id' => User::factory(),
            'wave' => 1,
            'offered_at' => now(),
            'expires_at' => now()->addSeconds(90),
            'responded_at' => null,
            'response' => null,
        ];
    }

    public function answered(OfferResponse $response): static
    {
        return $this->state(fn (): array => ['responded_at' => now(), 'response' => $response]);
    }

    /** Past its deadline, not answered. */
    public function expired(): static
    {
        return $this->state(fn (): array => ['offered_at' => now()->subSeconds(120), 'expires_at' => now()->subSeconds(30)]);
    }
}
