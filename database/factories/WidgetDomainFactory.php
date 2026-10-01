<?php

namespace Database\Factories;

use App\Models\WidgetDomain;
use Illuminate\Database\Eloquent\Factories\Factory;
use Illuminate\Support\Str;

/**
 * @extends Factory<WidgetDomain>
 */
class WidgetDomainFactory extends Factory
{
    /**
     * @return array<string, mixed>
     */
    public function definition(): array
    {
        return [
            'host' => Str::lower(fake()->unique()->domainName()),
            'is_wildcard' => false,
        ];
    }

    public function host(string $host): static
    {
        return $this->state(fn (): array => ['host' => $host, 'is_wildcard' => str_starts_with($host, '*.')]);
    }
}
