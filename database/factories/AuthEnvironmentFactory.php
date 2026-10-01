<?php

namespace Database\Factories;

use App\Models\AuthEnvironment;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<AuthEnvironment>
 */
class AuthEnvironmentFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'key' => AuthEnvironment::PRODUCTION,
            'label' => 'Production',
            'base_url' => 'https://auth.example.test',
            'api_prefix' => '/api/v1',
            'service_name' => 'pne-chat',
            'service_token' => 'svc-'.fake()->regexify('[A-Za-z0-9]{32}'),
            'nats_url' => null,
            'nats_token' => null,
            'nats_stream' => 'AUTH_EVENTS',
            'verify_tls' => true,
        ];
    }

    public function production(): static
    {
        return $this->state(fn (): array => ['key' => AuthEnvironment::PRODUCTION, 'label' => 'Production', 'base_url' => 'https://auth.example.test']);
    }

    public function testing(): static
    {
        return $this->state(fn (): array => ['key' => AuthEnvironment::TESTING, 'label' => 'Testing', 'base_url' => 'https://auth-testing.example.test']);
    }

    public function withNats(string $url = 'nats://nats.example.test:4222', ?string $token = 'nats-token-value'): static
    {
        return $this->state(fn (): array => ['nats_url' => $url, 'nats_token' => $token]);
    }
}
