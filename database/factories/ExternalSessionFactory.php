<?php

namespace Database\Factories;

use App\Models\ExternalSession;
use App\Models\UserExternalIdentity;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<ExternalSession>
 */
class ExternalSessionFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'identity_id' => UserExternalIdentity::factory(),
            'user_id' => fn (array $attributes) => UserExternalIdentity::query()->whereKey($attributes['identity_id'])->firstOrFail()->user_id,
            'auth_environment_id' => fn (array $attributes) => UserExternalIdentity::query()->whereKey($attributes['identity_id'])->firstOrFail()->auth_environment_id,
            'token' => fake()->numberBetween(1, 999).'|'.fake()->regexify('[A-Za-z0-9]{48}'),
            'last_verified_at' => now(),
            'verify_fail_count' => 0,
            'ip' => '127.0.0.1',
            'user_agent' => 'PHPUnit',
        ];
    }

    public function revoked(string $reason = 'test'): static
    {
        return $this->state(fn (): array => ['revoked_at' => now(), 'revoked_reason' => $reason, 'token' => null]);
    }
}
