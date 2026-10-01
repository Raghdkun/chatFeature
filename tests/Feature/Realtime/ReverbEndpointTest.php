<?php

namespace Tests\Feature\Realtime;

use App\Domain\Chat\Realtime\ReverbEndpoint;
use Tests\Support\InteractsWithRealtime;
use Tests\TestCase;

/**
 * `ReverbEndpoint::forVisitors()` (the `ws` block of `POST /public/sessions`): the PUBLIC address of Reverb and the app key, never
 * the internal publish address and never the secret.
 */
class ReverbEndpointTest extends TestCase
{
    use InteractsWithRealtime;

    /**
     * @param  array<string, mixed>  $overrides
     */
    private function configure(array $overrides = []): void
    {
        config([
            'broadcasting.default' => 'reverb',
            'broadcasting.connections.reverb.key' => 'public-key',
            'broadcasting.connections.reverb.secret' => 'very-secret',
            // Where THIS application publishes to (inside Docker): not for clients.
            'broadcasting.connections.reverb.options.host' => 'reverb',
            'broadcasting.connections.reverb.options.port' => 8080,
            'broadcasting.connections.reverb.options.scheme' => 'http',
            // Where the Reverb process listens: not for clients either.
            'reverb.servers.reverb.host' => '0.0.0.0',
            'reverb.servers.reverb.port' => 8080,
            // What clients connect to behind Caddy.
            'reverb.apps.apps.0.options.host' => 'chat.example.com',
            'reverb.apps.apps.0.options.port' => 443,
            'reverb.apps.apps.0.options.scheme' => 'https',
            ...$overrides,
        ]);
    }

    public function test_it_hands_out_the_key_and_the_public_address_behind_a_proxy(): void
    {
        $this->configure();

        $this->assertSame(
            ['key' => 'public-key', 'host' => 'chat.example.com', 'port' => 443, 'scheme' => 'https'],
            app(ReverbEndpoint::class)->forVisitors(),
        );
    }

    public function test_it_never_exposes_the_internal_addresses_or_the_secret(): void
    {
        $this->configure();

        $json = json_encode(app(ReverbEndpoint::class)->forVisitors(), JSON_THROW_ON_ERROR);

        foreach (['very-secret', 'reverb"', '8080', '0.0.0.0'] as $needle) {
            $this->assertStringNotContainsString($needle, $json);
        }
    }

    public function test_a_plain_http_development_setup(): void
    {
        $this->configure([
            'reverb.apps.apps.0.options.host' => 'localhost',
            'reverb.apps.apps.0.options.port' => '8312',
            'reverb.apps.apps.0.options.scheme' => 'http',
        ]);

        $this->assertSame(
            ['key' => 'public-key', 'host' => 'localhost', 'port' => 8312, 'scheme' => 'http'],
            app(ReverbEndpoint::class)->forVisitors(),
        );
    }

    public function test_the_types_are_the_documented_ones(): void
    {
        $this->configure(['reverb.apps.apps.0.options.port' => '443']);

        $endpoint = app(ReverbEndpoint::class)->forVisitors();

        $this->assertIsString($endpoint['key']);
        $this->assertIsString($endpoint['host']);
        $this->assertIsInt($endpoint['port']);
        $this->assertIsString($endpoint['scheme']);
        $this->assertSame(['key', 'host', 'port', 'scheme'], array_keys($endpoint));
    }

    public function test_an_unknown_scheme_or_a_nonsense_port_falls_back_to_secure_defaults(): void
    {
        $this->configure(['reverb.apps.apps.0.options.scheme' => 'ftp', 'reverb.apps.apps.0.options.port' => 0]);

        $endpoint = app(ReverbEndpoint::class)->forVisitors();

        $this->assertSame('https', $endpoint['scheme']);
        $this->assertSame(443, $endpoint['port']);
    }

    public function test_realtime_is_available_only_when_reverb_is_the_broadcaster_with_a_key_and_a_host(): void
    {
        $this->configure();
        $this->assertTrue(app(ReverbEndpoint::class)->isAvailable());

        $this->configure(['broadcasting.default' => 'null']);
        $this->assertFalse(app(ReverbEndpoint::class)->isAvailable(), 'the broadcaster is off (before the install, or Reverb is not configured)');

        $this->configure(['broadcasting.connections.reverb.key' => '']);
        $this->assertFalse(app(ReverbEndpoint::class)->isAvailable());

        $this->configure(['reverb.apps.apps.0.options.host' => '']);
        $this->assertFalse(app(ReverbEndpoint::class)->isAvailable());
    }

    public function test_it_is_a_container_singleton_other_tracks_can_inject(): void
    {
        $this->useRealtime();

        $this->assertSame(app(ReverbEndpoint::class), app(ReverbEndpoint::class));
    }
}
