<?php

namespace Tests\Feature\Auth;

use App\Auth\Pizzasys\NatsHealth;
use App\Auth\Pizzasys\NatsProbe;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\NatsSettings;
use App\Models\AuthEnvironment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Tests\Support\InstallStateFake;
use Tests\Support\InteractsWithPortal;
use Tests\TestCase;

class NatsSupportTest extends TestCase
{
    use InteractsWithPortal, RefreshDatabase;

    /**
     * A NATS server that already said what we want to read: the handshake reads INFO, writes CONNECT + PING, reads PONG.
     *
     * @param  list<string>  $lines
     * @return array{0: resource, 1: resource}
     */
    private function server(array $lines): array
    {
        [$client, $server] = stream_socket_pair(STREAM_PF_UNIX, STREAM_SOCK_STREAM, STREAM_IPPROTO_IP);

        foreach ($lines as $line) {
            fwrite($server, $line."\r\n");
        }

        return [$client, $server];
    }

    public function test_the_handshake_succeeds_and_sends_the_token_without_echoing_it(): void
    {
        [$client, $server] = $this->server(['INFO {"server_id":"x","auth_required":true}', 'PONG']);

        $result = (new NatsProbe)->handshake($client, 'nats-secret-token');

        $this->assertTrue($result['ok']);
        $this->assertStringNotContainsString('nats-secret-token', $result['message']);

        $sent = (string) fread($server, 4096);
        $this->assertStringStartsWith('CONNECT ', $sent);
        $this->assertStringContainsString('"auth_token":"nats-secret-token"', $sent);
        $this->assertStringContainsString("PING\r\n", $sent);
    }

    public function test_rejected_credentials_fail_like_every_other_failure_without_echoing_the_token(): void
    {
        [$client, $server] = $this->server(['INFO {"auth_required":true}', "-ERR 'Authorization Violation'"]);

        $result = (new NatsProbe)->handshake($client, 'wrong-token');

        $this->assertFalse($result['ok']);
        $this->assertStringNotContainsString('wrong-token', $result['message']);
        $this->assertStringStartsWith('Could not establish a NATS session', $result['message']);
        $this->assertIsResource($server);
    }

    public function test_a_server_that_is_not_nats_fails_without_saying_so(): void
    {
        [$client, $server] = $this->server(['HTTP/1.1 400 Bad Request']);

        $result = (new NatsProbe)->handshake($client, null);

        $this->assertFalse($result['ok']);
        $this->assertStringStartsWith('Could not establish a NATS session', $result['message']);
        $this->assertStringNotContainsString('not NATS', $result['message']);
        $this->assertIsResource($server);
    }

    public function test_an_unknown_reply_is_a_refusal(): void
    {
        [$client, $server] = $this->server(['INFO {}', "-ERR 'Maximum Connections Exceeded'"]);

        $this->assertFalse((new NatsProbe)->handshake($client, null)['ok']);
        $this->assertIsResource($server);
    }

    public function test_only_nats_addresses_are_probed(): void
    {
        $probe = new NatsProbe;

        foreach (['http://host:4222', 'not a url', 'nats://', ''] as $url) {
            $result = $probe->probe($url, null);
            $this->assertFalse($result['ok'], $url);
            $this->assertStringStartsWith('Could not establish a NATS session', $result['message']);
        }
    }

    public function test_an_unreachable_server_is_reported_without_its_address_or_the_token(): void
    {
        config(['chat.portal_allow_private_hosts' => true]);

        $result = (new NatsProbe)->probe('nats://127.0.0.1:1', 'secret-token');

        $this->assertFalse($result['ok']);
        $this->assertStringNotContainsString('127.0.0.1', $result['message']);
        $this->assertStringNotContainsString('secret-token', $result['message']);
    }

    // ---- NatsSettingsProvider ------------------------------------------------------------------------------------

    public function test_the_provider_reports_the_active_environments_nats_block(): void
    {
        $this->usePortalMode(['nats_url' => 'nats://nats.example.test:4222', 'nats_token' => 'tok-123', 'nats_stream' => 'AUTH_EVENTS']);
        settings()->set('auth.pizzasys.nats.enabled', true);

        $settings = app(NatsSettingsProvider::class)->current();

        $this->assertInstanceOf(NatsSettings::class, $settings);
        $this->assertTrue($settings->enabled);
        $this->assertSame('nats://nats.example.test:4222', $settings->url);
        $this->assertSame('tok-123', $settings->token);
        $this->assertSame('AUTH_EVENTS', $settings->stream);
        $this->assertTrue($settings->ensureStream);
        $this->assertSame('production', $settings->environmentKey);
    }

    public function test_the_provider_follows_the_active_environment(): void
    {
        $this->usePortalMode(['nats_url' => 'nats://prod.example.test:4222']);
        $this->useTestingEnvironment(attributes: ['nats_url' => 'nats://testing.example.test:4222', 'nats_stream' => 'AUTH_TESTING']);
        settings()->set('auth.pizzasys.active_env', 'testing');

        $settings = app(NatsSettingsProvider::class)->current();

        $this->assertSame('nats://testing.example.test:4222', $settings->url);
        $this->assertSame('AUTH_TESTING', $settings->stream);
        $this->assertSame('testing', $settings->environmentKey);
    }

    public function test_the_provider_is_empty_without_a_nats_url_outside_mode_two_and_before_install(): void
    {
        $this->usePortalMode();
        $this->assertNull(app(NatsSettingsProvider::class)->current(), 'no NATS URL');

        AuthEnvironment::query()->update(['nats_url' => 'nats://x:4222']);
        $this->assertNotNull(app(NatsSettingsProvider::class)->current());

        settings()->set('auth.mode', 'fortify');
        $this->assertNull(app(NatsSettingsProvider::class)->current(), 'mode 1');

        InstallStateFake::make(installed: false);
        $this->assertNull(app(NatsSettingsProvider::class)->current(), 'not installed: no database access');
    }

    // ---- heartbeat keys read by the health card -----------------------------------------------------------------

    public function test_the_health_reader_interprets_the_consumers_cache_keys(): void
    {
        $health = app(NatsHealth::class);
        $this->assertNull($health->connected(), 'no heartbeat yet');
        $this->assertNull($health->lastEventAt());

        Cache::put('auth.nats.heartbeat_at', now()->toIso8601String());
        Cache::put('auth.nats.connected', true);
        Cache::put('auth.nats.last_event_at', '2026-10-21T10:00:00+00:00');
        $this->assertTrue($health->connected());
        $this->assertSame('2026-10-21T10:00:00+00:00', $health->lastEventAt());

        Cache::put('auth.nats.connected', false);
        $this->assertFalse($health->connected());

        Cache::put('auth.nats.connected', true);
        $this->travel(3)->minutes();
        $this->assertFalse($health->connected(), 'a stale heartbeat means the consumer is not running');
    }
}
