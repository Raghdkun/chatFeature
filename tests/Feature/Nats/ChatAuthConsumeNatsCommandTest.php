<?php

namespace Tests\Feature\Nats;

use App\Infrastructure\Nats\NatsSettings;
use App\Models\ProcessedEvent;
use Tests\Support\Nats\NatsFixtures;

class ChatAuthConsumeNatsCommandTest extends NatsTestCase
{
    public function test_once_drains_the_queued_events_and_exits_zero(): void
    {
        $this->publishEvent('user.deleted');
        $this->publishEvent('user.role.assigned');
        $this->publishEvent('role.updated');

        $this->artisan('chat:auth:consume-nats', ['--once' => true])
            ->expectsOutputToContain('received=3 handled=3 noops=0 duplicates=0 unknown=0 failed=0')
            ->assertExitCode(0);

        $this->assertSame([
            ['deactivateExternalId', '10'],
            ['flushForExternalId', '10'],
            ['flushAll', null],
        ], $this->invalidator->calls);
        $this->assertCount(3, $this->gateway->acked);
        $this->assertSame(3, ProcessedEvent::query()->count());
    }

    public function test_max_messages_stops_after_that_many_deliveries(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->publishEvent('user.deleted', ['id' => NatsFixtures::ulid()]);
        }

        $this->artisan('chat:auth:consume-nats', ['--max-messages' => 2])
            ->expectsOutputToContain('received=2')
            ->assertExitCode(0);

        $this->assertSame(3, $this->gateway->pendingCount());
    }

    public function test_instance_names_the_durable_consumer(): void
    {
        $this->artisan('chat:auth:consume-nats', ['--once' => true, '--instance' => 'Blue Worker!'])->assertExitCode(0);
        $this->assertSame('pne-chat-testing-blue-worker', $this->gateway->consumer?->durable);

        $this->artisan('chat:auth:consume-nats', ['--once' => true, '--instance' => '***'])->assertExitCode(0);
        $this->assertSame('pne-chat-testing-default', $this->gateway->consumer?->durable);
    }

    public function test_disabled_nats_exits_zero_without_touching_the_network(): void
    {
        $this->settings->current = new NatsSettings(enabled: false, url: 'nats://nats.test:4222', token: null);

        $this->artisan('chat:auth:consume-nats', ['--once' => true])->assertExitCode(0);

        $this->assertSame([], $this->gateway->calls);
    }

    public function test_unconfigured_nats_exits_zero_without_touching_the_network(): void
    {
        $this->settings->current = null;

        $this->artisan('chat:auth:consume-nats', ['--once' => true])->assertExitCode(0);

        $this->assertSame([], $this->gateway->calls);
    }

    public function test_an_unreachable_server_fails_a_one_shot_run_without_leaking_details(): void
    {
        $this->gateway->failConnects = 1;

        $this->artisan('chat:auth:consume-nats', ['--once' => true])
            ->expectsOutputToContain('The NATS consumer stopped: App\Infrastructure\Nats\GatewayException')
            ->assertExitCode(1);
    }

    public function test_invalid_max_messages_is_rejected(): void
    {
        foreach (['0', '-1', 'abc'] as $value) {
            $this->artisan('chat:auth:consume-nats', ['--max-messages' => $value])
                ->expectsOutputToContain('--max-messages must be a positive integer')
                ->assertExitCode(2);
        }

        $this->assertSame([], $this->gateway->calls);
    }
}
