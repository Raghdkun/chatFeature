<?php

namespace Database\Factories;

use App\Models\AuthEnvironment;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<UserExternalIdentity>
 */
class UserExternalIdentityFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'user_id' => User::factory()->state(['auth_source' => 'pizzasys', 'password' => null]),
            // Reuses the environment that already exists (there are only two keys); creates one otherwise.
            'auth_environment_id' => fn (): int => AuthEnvironment::query()->value('id') ?? AuthEnvironment::factory()->create()->getKey(),
            'external_id' => (string) fake()->unique()->numberBetween(1, 9_999_999),
            'roles' => [],
            'permissions' => ['chat.agent'],
            'active' => true,
            'last_verified_at' => now(),
            'stale_at' => null,
            'deactivated_at' => null,
        ];
    }

    /**
     * @param  list<string>  $roles
     * @param  list<string>  $permissions
     */
    public function granting(array $roles = [], array $permissions = []): static
    {
        return $this->state(fn (): array => ['roles' => $roles, 'permissions' => $permissions]);
    }

    public function stale(): static
    {
        return $this->state(fn (): array => ['stale_at' => now()]);
    }

    public function deactivated(): static
    {
        return $this->state(fn (): array => ['active' => false, 'deactivated_at' => now()]);
    }
}
