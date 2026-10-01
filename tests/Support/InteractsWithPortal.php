<?php

namespace Tests\Support;

use App\Models\AuthEnvironment;

/**
 * Puts a test application into auth mode 2 against the fake portal ({@see PizzasysMock}).
 */
trait InteractsWithPortal
{
    /**
     * Switches `auth.mode` to pizzasys and stores the active (production) environment, pointed at the fake portal.
     *
     * @param  array<string, mixed>  $attributes
     */
    protected function usePortalMode(array $attributes = []): AuthEnvironment
    {
        settings()->set('auth.mode', 'pizzasys');

        return AuthEnvironment::factory()->production()->create([
            'base_url' => PizzasysMock::BASE_URL,
            'service_name' => PizzasysMock::SERVICE_NAME,
            'service_token' => PizzasysMock::SERVICE_TOKEN,
            ...$attributes,
        ]);
    }

    /**
     * A testing environment pointed at a second fake portal.
     *
     * @param  array<string, mixed>  $attributes
     */
    protected function useTestingEnvironment(string $baseUrl = 'https://auth-testing.example.test', array $attributes = []): AuthEnvironment
    {
        return AuthEnvironment::factory()->testing()->create([
            'base_url' => $baseUrl,
            'service_name' => PizzasysMock::SERVICE_NAME,
            'service_token' => PizzasysMock::SERVICE_TOKEN,
            ...$attributes,
        ]);
    }
}
