<?php

namespace Database\Factories;

use App\Auth\Enums\UserRole;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Str;

/**
 * @extends Factory<User>
 */
class UserFactory extends Factory
{
    /**
     * The current password being used by the factory.
     */
    protected static ?string $password;

    /**
     * Define the model's default state.
     *
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'name' => fake()->name(),
            'email' => fake()->unique()->safeEmail(),
            'email_verified_at' => now(),
            'password' => static::$password ??= Hash::make('password'),
            'remember_token' => Str::random(10),
            'two_factor_secret' => null,
            'two_factor_recovery_codes' => null,
            'two_factor_confirmed_at' => null,
            'role' => UserRole::Agent,
            'is_admin' => false,
            'is_agent' => true,
            'is_active' => true,
            'auth_source' => 'local',
        ];
    }

    /**
     * An administrator (who can also take chats).
     */
    public function admin(): static
    {
        return $this->state(fn (array $attributes) => [
            'role' => UserRole::Admin,
            'is_admin' => true,
            'is_agent' => true,
        ]);
    }

    /**
     * A support agent (the default).
     */
    public function agent(): static
    {
        return $this->state(fn (array $attributes) => [
            'role' => UserRole::Agent,
            'is_admin' => false,
            'is_agent' => true,
        ]);
    }

    /**
     * A user who is neither admin nor agent: signed in but not allowed into the dashboard.
     */
    public function withoutChatAccess(): static
    {
        return $this->state(fn (array $attributes) => [
            'is_admin' => false,
            'is_agent' => false,
        ]);
    }

    /**
     * A deactivated account.
     */
    public function inactive(): static
    {
        return $this->state(fn (array $attributes) => [
            'is_active' => false,
        ]);
    }

    /**
     * Indicate that the model's email address should be unverified.
     */
    public function unverified(): static
    {
        return $this->state(fn (array $attributes) => [
            'email_verified_at' => null,
        ]);
    }

    /**
     * Indicate that the model has two-factor authentication configured.
     */
    public function withTwoFactor(): static
    {
        return $this->state(fn (array $attributes) => [
            'two_factor_secret' => encrypt('secret'),
            'two_factor_recovery_codes' => encrypt(json_encode(['recovery-code-1'])),
            'two_factor_confirmed_at' => now(),
        ]);
    }
}
