<?php

namespace Database\Factories;

use App\Domain\Widgets\Data\WidgetConfigData;
use App\Domain\Widgets\Support\WidgetKeyGenerator;
use App\Models\WhatsAppSession;
use App\Models\Widget;
use App\Models\WidgetDomain;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Crypt;

/**
 * @extends Factory<Widget>
 */
class WidgetFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $config = (new WidgetConfigData)->toArray();

        return [
            'workspace_id' => null,
            'public_key' => WidgetKeyGenerator::generate(),
            'name' => fake()->company().' widget',
            'is_enabled' => false,
            'locale' => 'en',
            'config' => $config,
            'draft_config' => $config,
            'config_version' => 1,
            'idle_timeout_minutes' => 120,
            'queue_timeout_seconds' => 90,
            'offline_mode' => 'auto_hours',
            'timezone' => 'UTC',
            'allow_non_browser_clients' => false,
            'identity_secret_encrypted' => null,
        ];
    }

    public function enabled(): static
    {
        return $this->state(fn (): array => ['is_enabled' => true]);
    }

    public function withIdentitySecret(string $secret): static
    {
        return $this->state(fn (): array => ['identity_secret_encrypted' => Crypt::encryptString($secret)]);
    }

    /** Hands visitors over to a connected WhatsApp session (a new one when none is given). */
    public function withWhatsAppSession(?WhatsAppSession $session = null): static
    {
        return $this->state(fn (): array => ['whatsapp_session_id' => $session->id ?? WhatsAppSession::factory()->ready()]);
    }

    public function allowingNonBrowserClients(): static
    {
        return $this->state(fn (): array => ['allow_non_browser_clients' => true]);
    }

    /**
     * Allow these (already normalised) hosts to embed the widget.
     *
     * @param  list<string>  $hosts
     */
    public function withDomains(array $hosts): static
    {
        return $this->afterCreating(function (Widget $widget) use ($hosts): void {
            foreach ($hosts as $host) {
                WidgetDomain::factory()->for($widget)->host($host)->create();
            }
        });
    }
}
