<?php

namespace Database\Factories;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Models\AgentPresence;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<AgentPresence>
 */
class AgentPresenceFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'status' => PresenceStatus::Offline,
            'is_manual' => false,
            'last_seen_at' => null,
            'last_heartbeat_at' => null,
        ];
    }

    public function online(): static
    {
        return $this->state(fn (): array => ['status' => PresenceStatus::Online, 'last_seen_at' => now(), 'last_heartbeat_at' => now()]);
    }

    public function away(): static
    {
        return $this->state(fn (): array => ['status' => PresenceStatus::Away, 'last_seen_at' => now(), 'last_heartbeat_at' => now()]);
    }

    /** The agent chose the status themselves. */
    public function manual(): static
    {
        return $this->state(fn (): array => ['is_manual' => true]);
    }
}
