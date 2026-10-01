<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Auth\Pizzasys\DatabaseNatsSettingsProvider;
use App\Infrastructure\Nats\BasisJetStreamGateway;
use App\Infrastructure\Nats\CloudEvent;
use App\Infrastructure\Nats\ConfigNatsSettingsProvider;
use App\Infrastructure\Nats\Contracts\Clock;
use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\EventOutcome;
use App\Infrastructure\Nats\EventRouter;
use App\Infrastructure\Nats\Handlers\Handler;
use App\Infrastructure\Nats\NatsSettings;
use App\Infrastructure\Nats\SystemClock;
use Tests\Support\Nats\FakeNatsSettingsProvider;
use Tests\Support\Nats\RecordingIdentityInvalidator;
use Tests\TestCase;

class NatsBindingsTest extends TestCase
{
    public function test_the_application_binds_the_database_backed_provider_over_the_config_default(): void
    {
        // Track 2A rebinds the provider (active auth environment); the config-backed class stays the standalone default.
        $this->assertInstanceOf(DatabaseNatsSettingsProvider::class, $this->app->make(NatsSettingsProvider::class));
        $this->assertInstanceOf(ConfigNatsSettingsProvider::class, $this->app->make(ConfigNatsSettingsProvider::class));
    }

    public function test_an_explicit_binding_such_as_the_database_backed_one_overrides_the_default(): void
    {
        $this->app->bind(NatsSettingsProvider::class, FakeNatsSettingsProvider::class);

        $this->assertInstanceOf(FakeNatsSettingsProvider::class, $this->app->make(NatsSettingsProvider::class));
    }

    public function test_the_gateway_and_clock_default_to_the_real_implementations(): void
    {
        $this->assertInstanceOf(BasisJetStreamGateway::class, $this->app->make(JetStreamGateway::class));
        $this->assertInstanceOf(SystemClock::class, $this->app->make(Clock::class));
    }

    public function test_other_contexts_can_plug_new_event_handlers_into_the_router(): void
    {
        $this->app->instance(IdentityInvalidator::class, new RecordingIdentityInvalidator);
        $handler = new class implements Handler
        {
            public function handle(CloudEvent $event): EventOutcome
            {
                return EventOutcome::Noop;
            }
        };
        $this->app->afterResolving(EventRouter::class, fn (EventRouter $router) => $router->register('service.*', $handler));

        $event = CloudEvent::fromJson(json_encode(['specversion' => '1.0', 'id' => '01M3TNCWV4NRSSY7H4131KBAZC', 'type' => 'auth.v1.service.token_rotated']));

        $this->assertSame($handler, $this->app->make(EventRouter::class)->resolve($event));
    }

    public function test_nats_is_off_and_unconfigured_by_default(): void
    {
        $this->assertFalse(config('nats.enabled'));
        $this->assertNull($this->app->make(ConfigNatsSettingsProvider::class)->current());
    }

    public function test_the_config_provider_maps_the_nats_config(): void
    {
        config([
            'nats.enabled' => true,
            'nats.url' => ' nats://127.0.0.1:4222 ',
            'nats.token' => 'dev-token',
            'nats.stream' => 'AUTH_EVENTS_DEV',
            'nats.ensure_stream' => false,
            'nats.environment_key' => 'testing',
        ]);

        $settings = $this->app->make(ConfigNatsSettingsProvider::class)->current();

        $this->assertEquals(new NatsSettings(
            enabled: true,
            url: 'nats://127.0.0.1:4222',
            token: 'dev-token',
            stream: 'AUTH_EVENTS_DEV',
            ensureStream: false,
            environmentKey: 'testing',
        ), $settings);
    }

    public function test_the_config_provider_applies_defaults_and_treats_blank_values_as_absent(): void
    {
        config(['nats.enabled' => false, 'nats.url' => 'nats://nats:4222', 'nats.token' => '  ', 'nats.stream' => '', 'nats.environment_key' => null]);

        $settings = $this->app->make(ConfigNatsSettingsProvider::class)->current();

        $this->assertInstanceOf(NatsSettings::class, $settings);
        $this->assertFalse($settings->enabled);
        $this->assertNull($settings->token);
        $this->assertSame('AUTH_EVENTS', $settings->stream);
        $this->assertTrue($settings->ensureStream);
        $this->assertSame('production', $settings->environmentKey);
        $this->assertNull($settings->tlsCaFile);
    }

    public function test_a_blank_url_means_not_configured(): void
    {
        config(['nats.enabled' => true, 'nats.url' => '  ']);

        $this->assertNull($this->app->make(ConfigNatsSettingsProvider::class)->current());
    }
}
