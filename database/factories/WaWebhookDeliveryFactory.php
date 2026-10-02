<?php

namespace Database\Factories;

use App\Domain\WhatsApp\Enums\WebhookOutcome;
use App\Models\WaWebhookDelivery;
use App\Models\WhatsAppSession;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * Default: a `message.received` delivery that was processed. `pending()` is one that was accepted and waits for the queue;
 * `duplicate()`, `rejected()`, `ignored()` and `failed()` are the other outcomes.
 *
 * @extends Factory<WaWebhookDelivery>
 */
class WaWebhookDeliveryFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $at = now();

        return [
            'session_id' => WhatsAppSession::factory()->ready(),
            'idempotency_key' => 'msg_'.fake()->uuid().'_'.Str::upper(Str::random(20)).'_'.fake()->uuid(),
            'delivery_id' => 'dlv_'.fake()->uuid(),
            'event' => 'message.received',
            'outcome' => WebhookOutcome::Processed,
            'received_at' => $at,
            'processed_at' => $at,
            'error' => null,
        ];
    }

    /** Accepted, waiting for the queue worker. */
    public function pending(): static
    {
        return $this->state(fn (): array => ['outcome' => null, 'processed_at' => null]);
    }

    public function duplicate(): static
    {
        return $this->state(fn (): array => ['outcome' => WebhookOutcome::Duplicate]);
    }

    public function rejected(): static
    {
        return $this->state(fn (): array => ['outcome' => WebhookOutcome::Rejected]);
    }

    public function ignored(string $event = 'presence.update'): static
    {
        return $this->state(fn (): array => ['outcome' => WebhookOutcome::Ignored, 'event' => $event]);
    }

    public function failed(string $error = 'The job threw.'): static
    {
        return $this->state(fn (): array => ['outcome' => WebhookOutcome::Failed, 'error' => $error]);
    }
}
