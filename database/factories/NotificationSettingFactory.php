<?php

namespace Database\Factories;

use App\Domain\Notifications\Enums\PromptState;
use App\Models\NotificationSetting;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * Default preferences, never asked.
 *
 * @extends Factory<NotificationSetting>
 */
class NotificationSettingFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
            'sound' => true,
            'push_offers' => true,
            'push_messages' => true,
            'include_preview' => true,
            'quiet_hours' => null,
            'prompt_state' => PromptState::Never,
            'prompted_at' => null,
            'snoozed_until' => null,
        ];
    }

    public function granted(): static
    {
        return $this->state(fn (): array => ['prompt_state' => PromptState::Granted, 'prompted_at' => now()]);
    }

    public function denied(): static
    {
        return $this->state(fn (): array => ['prompt_state' => PromptState::Denied, 'prompted_at' => now()]);
    }

    public function snoozedUntil(\DateTimeInterface $until): static
    {
        return $this->state(fn (): array => ['prompt_state' => PromptState::Snoozed, 'prompted_at' => now(), 'snoozed_until' => $until]);
    }

    public function withoutOfferPush(): static
    {
        return $this->state(fn (): array => ['push_offers' => false]);
    }

    public function withoutMessagePush(): static
    {
        return $this->state(fn (): array => ['push_messages' => false]);
    }

    /**
     * @param  array{start?: string, end?: string, timezone?: string}  $window
     */
    public function quietHours(array $window = []): static
    {
        return $this->state(fn (): array => ['quiet_hours' => ['enabled' => true, 'start' => '22:00', 'end' => '07:00', 'timezone' => 'UTC', ...$window]]);
    }
}
