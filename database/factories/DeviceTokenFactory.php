<?php

namespace Database\Factories;

use App\Models\DeviceToken;
use App\Models\User;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<DeviceToken>
 */
class DeviceTokenFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        $token = Str::random(152);

        return [
            'user_id' => User::factory(),
            'platform' => 'android',
            'token_hash' => DeviceToken::hashToken($token),
            'token' => $token,
            'last_seen_at' => now(),
        ];
    }
}
