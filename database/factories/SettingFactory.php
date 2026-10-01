<?php

namespace Database\Factories;

use App\Models\Setting;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Setting>
 */
class SettingFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'workspace_id' => null,
            'group' => 'app',
            'key' => 'app.'.fake()->unique()->slug(2),
            'value' => json_encode(fake()->word()),
            'is_encrypted' => false,
            'updated_by' => null,
        ];
    }
}
