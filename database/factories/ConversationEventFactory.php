<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\ActorType;
use App\Models\Conversation;
use App\Models\ConversationEvent;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ConversationEvent>
 */
class ConversationEventFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'conversation_id' => Conversation::factory(),
            'type' => 'created',
            'actor_type' => ActorType::System,
            'actor_id' => null,
            'payload' => null,
        ];
    }
}
