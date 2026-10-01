<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\ConsumerRunOptions;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\NatsConsumer;
use App\Infrastructure\Nats\NatsSettings;
use App\Infrastructure\Nats\NatsStatusStore;
use App\Models\ProcessedEvent;
use Illuminate\Support\Facades\Cache;
use RuntimeException;
use Tests\Support\InstallStateFake;
use Tests\Support\Nats\FakeJetStreamGateway;
use Tests\Support\Nats\NatsFixtures;

class NatsConsumerTest extends NatsTestCase
{
    public function test_it_processes_every_recorded_event_and_acks_each_one(): void
    {
        foreach (NatsFixtures::all() as $envelope) {
            $this->gateway->publish(json_encode($envelope, JSON_THROW_ON_ERROR), $envelope['subject']);
        }

        $stats = $this->runOnce();

        $this->assertSame(34, $stats->received);
        $this->assertSame(0, $stats->unknown + $stats->failed + $stats->malformed + $stats->duplicates);
        $this->assertSame(34, $stats->handled + $stats->noops);
        $this->assertCount(34, $this->gateway->acked);
        $this->assertSame([], [...$this->gateway->nakked, ...$this->gateway->termed]);
        $this->assertSame(34, ProcessedEvent::query()->count());
        $this->assertSame(0, ProcessedEvent::query()->whereIn('outcome', ['pending', 'unknown'])->count());

        $byMethod = array_count_values(array_column($this->invalidator->calls, 0));
        $this->assertSame(['flushForExternalId' => 16, 'flushAll' => 14, 'deactivateExternalId' => 1], $byMethod, '3 of the 34 events (role/permission created) need no action');
    }

    public function test_a_replayed_event_id_is_acked_and_skipped(): void
    {
        $first = $this->publishEvent('user.deleted');
        $second = $this->publishEvent('user.deleted');
        $third = $this->publishEvent('user.deleted');

        $stats = $this->runOnce();

        $this->assertSame([['deactivateExternalId', '10']], $this->invalidator->calls);
        $this->assertSame([$first, $second, $third], $this->gateway->acked);
        $this->assertSame(1, $stats->handled);
        $this->assertSame(2, $stats->duplicates);
        $this->assertSame(1, ProcessedEvent::query()->count());
    }

    public function test_events_replayed_after_a_restart_are_deduplicated_through_the_ledger(): void
    {
        $this->publishEvent('role.updated');
        $this->runOnce();

        $this->publishEvent('role.updated');
        $stats = $this->runOnce($this->app->make(NatsConsumer::class));

        $this->assertSame([['flushAll', null]], $this->invalidator->calls);
        $this->assertSame(1, $stats->duplicates);
    }

    public function test_a_failing_handler_is_nakked_with_growing_delays_then_dead_lettered_after_five_deliveries(): void
    {
        $this->invalidator->beforeCall = function (): void {
            throw new RuntimeException('handler failed for '.self::SECRET);
        };
        $payload = ['data' => ['user_id' => 10, 'changed_fields' => ['password' => ['from' => self::SECRET, 'to' => self::SECRET]]]];
        $id = $this->publishEvent('user.updated', $payload);

        $stats = $this->runOnce();

        $this->assertSame([[$id, 2.0], [$id, 10.0], [$id, 30.0], [$id, 60.0]], $this->gateway->nakked);
        $this->assertSame([$id], $this->gateway->termed);
        $this->assertSame([], $this->gateway->acked);
        $this->assertSame(5, $stats->failed);
        $this->assertSame(1, $stats->deadLettered);
        $this->assertSame(0, ProcessedEvent::query()->count(), 'every failed attempt rolled its claim back');

        $lines = $this->deadLetters();
        $this->assertCount(1, $lines);
        $this->assertEqualsCanonicalizing(
            ['at', 'reason', 'event_id', 'type', 'subject', 'stream_sequence', 'deliveries', 'error'],
            array_keys($lines[0]),
        );
        $this->assertSame('handler_failed', $lines[0]['reason']);
        $this->assertSame(NatsFixtures::envelope('user.updated')['id'], $lines[0]['event_id']);
        $this->assertSame('auth.v1.user.updated', $lines[0]['type']);
        $this->assertSame('auth.v1.user.updated', $lines[0]['subject']);
        $this->assertSame(5, $lines[0]['deliveries']);
        $this->assertSame($id, $lines[0]['stream_sequence']);
        $this->assertSame('RuntimeException', $lines[0]['error']);
        $this->assertSame('2026-10-01T12:00:00+00:00', substr($lines[0]['at'], 0, 25));
        $this->assertNoSecretPersisted();
    }

    public function test_a_handler_that_recovers_is_acked_on_the_redelivery_and_nothing_is_dead_lettered(): void
    {
        $failures = 2;
        $this->invalidator->beforeCall = function () use (&$failures): void {
            if ($failures-- > 0) {
                throw new RuntimeException('transient');
            }
        };
        $id = $this->publishEvent('user.permission.revoked');

        $stats = $this->runOnce();

        $this->assertSame([[$id, 2.0], [$id, 10.0]], $this->gateway->nakked);
        $this->assertSame([$id], $this->gateway->acked);
        $this->assertSame([], $this->gateway->termed);
        $this->assertSame([], $this->deadLetters());
        $this->assertSame([['flushForExternalId', '10']], $this->invalidator->calls);
        $this->assertSame(2, $stats->failed);
        $this->assertSame(1, $stats->handled);
        $this->assertSame('flush_user', ProcessedEvent::query()->sole()->outcome);
    }

    public function test_bodies_that_are_not_a_valid_cloudevent_are_terminated_and_recorded_without_their_payload(): void
    {
        $notJson = $this->gateway->publish('<<'.self::SECRET.'>>', 'auth.v1.user.updated');
        $wrongVersion = $this->gateway->publish(json_encode(['specversion' => '9.9', 'id' => NatsFixtures::ulid(), 'type' => 'auth.v1.user.deleted', 'data' => ['password' => self::SECRET]]), 'auth.v1.user.deleted');
        $noId = $this->gateway->publish(json_encode(['specversion' => '1.0', 'type' => 'auth.v1.user.deleted', 'data' => ['password' => self::SECRET]]), 'auth.v1.user.deleted');

        $stats = $this->runOnce();

        $this->assertSame([$notJson, $wrongVersion, $noId], $this->gateway->termed);
        $this->assertSame([], $this->gateway->acked);
        $this->assertSame([], $this->invalidator->calls);
        $this->assertSame(3, $stats->malformed);
        $this->assertSame(['not_json', 'unsupported_specversion', 'missing_id'], array_column($this->deadLetters(), 'reason'));
        $this->assertSame([null, null, null], array_column($this->deadLetters(), 'event_id'));
        $this->assertSame(0, ProcessedEvent::query()->count());
        $this->assertNoSecretPersisted();
    }

    public function test_unknown_event_types_are_acked_counted_and_never_dispatched(): void
    {
        $id = $this->publishEvent('user.created', [
            'id' => NatsFixtures::ulid(),
            'type' => 'auth.v1.widget.exploded',
            'subject' => 'auth.v1.widget.exploded',
            'data' => ['user_id' => 3, 'password' => self::SECRET],
        ]);

        $stats = $this->runOnce();

        $this->assertSame([$id], $this->gateway->acked);
        $this->assertSame(1, $stats->unknown);
        $this->assertSame([], $this->invalidator->calls);
        $this->assertSame(1, ProcessedEvent::query()->where('outcome', 'unknown')->count());
        $this->assertSame('unknown', $this->log->messages('nats.event')[0]['context']['outcome']);
        $this->assertNoSecretPersisted();
    }

    public function test_no_payload_ever_reaches_the_logs(): void
    {
        $this->publishEvent('user.updated', ['data' => ['user_id' => 10, 'changed_fields' => ['password' => ['from' => self::SECRET, 'to' => self::SECRET]]]]);
        $this->publishEvent('user.deleted', ['data' => ['user_id' => 11, 'email' => 'secret.person@example.test']]);
        $this->gateway->publish('garbage '.self::SECRET);
        $this->invalidator->beforeCall = function (string $method, ?string $id): void {
            if ($id === '11') {
                throw new RuntimeException('failing with '.self::SECRET);
            }
        };

        $this->runOnce();

        $logs = $this->log->dump();
        $this->assertStringNotContainsString('secret.person', $logs);
        $this->assertStringContainsString(NatsFixtures::envelope('user.updated')['id'], $logs, 'ids are logged');
        $this->assertStringContainsString('auth.v1.user.updated', $logs, 'types are logged');
        $this->assertNoSecretPersisted();

        foreach ($this->log->records as $record) {
            $this->assertContains($record['message'], ['nats.consumer.state', 'nats.event', 'nats.event.failed', 'nats.event.malformed']);
        }
    }

    public function test_it_ensures_the_stream_and_the_durable_pull_consumer(): void
    {
        $this->runOnce();

        $this->assertSame([['AUTH_EVENTS', 'auth.v1.>', 30 * 86_400]], $this->gateway->streamsEnsured);
        $this->assertSame(['connect', 'ensureStream', 'ensureConsumer'], array_slice($this->gateway->calls, 0, 3));

        $spec = $this->gateway->consumer;
        $this->assertNotNull($spec);
        $this->assertSame('AUTH_EVENTS', $spec->stream);
        $this->assertSame('pne-chat-testing-default', $spec->durable);
        $this->assertSame('auth.v1.>', $spec->filter);
        $this->assertSame(5, $spec->maxDeliver);
        $this->assertSame(30, $spec->ackWaitSeconds);
        $this->assertSame('new', $spec->deliverPolicy);
        $this->assertSame('nats://nats.test:4222', $this->gateway->settings?->url);
    }

    public function test_the_stream_is_only_created_when_enabled_in_the_settings_and_the_instance_names_the_consumer(): void
    {
        $this->settings->current = new NatsSettings(enabled: true, url: 'nats://nats.test:4222', token: null, stream: 'CUSTOM_STREAM', ensureStream: false);

        $this->consumer()->run(new ConsumerRunOptions(once: true, instance: 'worker-2'));

        $this->assertSame([], $this->gateway->streamsEnsured);
        $this->assertSame('CUSTOM_STREAM', $this->gateway->consumer?->stream);
        $this->assertSame('pne-chat-testing-worker-2', $this->gateway->consumer?->durable);
    }

    public function test_it_polls_with_the_configured_batch_and_expiry(): void
    {
        $consumer = $this->consumer();
        $this->gateway->onFetch = fn () => $consumer->stop();

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame([[50, 5.0]], $this->gateway->fetches);
    }

    public function test_max_messages_caps_the_batch_and_leaves_the_rest_queued(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->publishEvent('user.deleted', ['id' => NatsFixtures::ulid()]);
        }

        $stats = $this->runOnce(maxMessages: 4);

        $this->assertSame(4, $stats->received);
        $this->assertSame([[4, 1.0]], $this->gateway->fetches);
        $this->assertCount(4, $this->gateway->acked);
        $this->assertSame(6, $this->gateway->pendingCount());
    }

    public function test_it_reports_heartbeat_connection_state_and_the_last_event(): void
    {
        $consumer = $this->consumer();
        $status = $this->app->make(NatsStatusStore::class);
        $connectedWhilePolling = [];
        $this->publishEvent('role.deleted');
        $this->gateway->onFetch = function (int $count) use ($consumer, $status, &$connectedWhilePolling): void {
            $connectedWhilePolling[] = [$status->connected(), Cache::get('auth.nats.connected')];

            if ($count === 4) {
                $consumer->stop();
            }
        };

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame([[true, true], [true, true], [true, true], [true, true]], $connectedWhilePolling);
        $this->assertFalse($status->connected());
        $this->assertFalse(Cache::get('auth.nats.connected'));
        $this->assertTrue($status->heartbeatAt()?->equalTo($this->clock->now()), 'the heartbeat follows the loop clock');
        $this->assertSame('2026-10-01T12:00:00+00:00', Cache::get('auth.nats.last_event_at'));
        $this->assertSame('2026-10-01T12:00:00+00:00', $status->lastEventAt()?->toIso8601String());
        $this->assertSame('2026-10-01T12:00:15+00:00', Cache::get('auth.nats.heartbeat_at'));
    }

    public function test_it_reconnects_when_the_restart_signal_changes_but_not_before_the_poll_interval(): void
    {
        $consumer = $this->consumer();
        $this->gateway->onFetch = function (int $count, FakeJetStreamGateway $gateway) use ($consumer): void {
            if ($count === 3) {
                Cache::increment(NatsStatusStore::RESTART);
            }

            if ($gateway->connectCount === 2 && $count >= 8) {
                $consumer->stop();
            }
        };

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame(2, $this->gateway->connectCount);
        $this->assertSame([0, 6], $this->gateway->fetchCountAtConnect, 'the signal is only polled every 30 s (6 empty 5 s polls)');
        $this->assertSame(['connect', 'ensureStream', 'ensureConsumer'], array_slice($this->gateway->calls, 0, 3));
        $this->assertSame(2, array_count_values($this->gateway->calls)['disconnect'], 'the old connection is closed before reconnecting');
        $this->assertSame('disconnect', end($this->gateway->calls));
        $this->assertSame(['connected', 'restarting', 'connected', 'stopped'], $this->states());
    }

    public function test_it_re_reads_the_settings_when_restarting(): void
    {
        $consumer = $this->consumer();
        $this->gateway->onFetch = function (int $count, FakeJetStreamGateway $gateway) use ($consumer): void {
            if ($count === 1) {
                Cache::increment(NatsStatusStore::RESTART);
                $this->settings->current = new NatsSettings(enabled: true, url: 'nats://other.test:4222', token: 'rotated');
            }

            if ($gateway->connectCount === 2) {
                $consumer->stop();
            }
        };

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame('nats://other.test:4222', $this->gateway->settings?->url);
        $this->assertSame('rotated', $this->gateway->settings?->token);
    }

    public function test_it_re_ensures_the_stream_and_consumer_periodically_so_a_wiped_server_heals(): void
    {
        $consumer = $this->consumer();
        $this->gateway->onFetch = fn (int $count) => $count >= 62 ? $consumer->stop() : null;

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame(2, $this->gateway->consumerEnsures, 'once at connect, once after 300 s');
        $this->assertCount(2, $this->gateway->streamsEnsured);
        $this->assertSame(1, $this->gateway->connectCount);
    }

    public function test_connection_failures_back_off_exponentially_then_recover(): void
    {
        $this->gateway->failConnects = 3;
        $consumer = $this->consumer();
        $sleptBeforeConnecting = null;
        $this->gateway->onFetch = function () use ($consumer, &$sleptBeforeConnecting): void {
            $sleptBeforeConnecting = $this->clock->totalSlept();
            $consumer->stop();
        };

        $stats = $consumer->run(new ConsumerRunOptions);

        $this->assertSame(4, $this->gateway->connectCount);
        $this->assertSame(3, $stats->reconnects);
        $this->assertGreaterThanOrEqual(0.5 + 1.0 + 2.0, $sleptBeforeConnecting);
        $this->assertLessThanOrEqual(1.0 + 2.0 + 4.0, $sleptBeforeConnecting);
        $this->assertCount(3, $this->log->messages('nats.consumer.error'));
        $this->assertSame(['reconnecting', 'connected', 'stopped'], $this->states());
        $this->assertSame('GatewayException', class_basename($this->log->messages('nats.consumer.error')[0]['context']['error']));
    }

    public function test_a_connection_lost_mid_stream_reconnects_and_resumes_processing(): void
    {
        $consumer = $this->consumer();
        $id = $this->publishEvent('store.updated');
        $this->gateway->onFetch = function (int $count) use ($consumer): void {
            if ($count === 1) {
                throw new GatewayException('Could not fetch from JetStream: broken pipe');
            }

            if ($count === 3) {
                $consumer->stop();
            }
        };

        $stats = $consumer->run(new ConsumerRunOptions);

        $this->assertSame(2, $this->gateway->connectCount);
        $this->assertSame(1, $stats->reconnects);
        $this->assertSame([$id], $this->gateway->acked);
        $this->assertSame([['flushAll', null]], $this->invalidator->calls);
        $this->assertLessThanOrEqual(1.0 + 5.0 + 5.0, $this->clock->totalSlept());
    }

    public function test_in_once_mode_a_connection_failure_is_not_swallowed(): void
    {
        $this->gateway->failConnects = 1;

        try {
            $this->runOnce();
            $this->fail('A one-shot run must report that it could not reach NATS.');
        } catch (GatewayException $exception) {
            $this->assertStringContainsString('simulated outage', $exception->getMessage());
        }

        $this->assertFalse(Cache::get('auth.nats.connected'));
    }

    public function test_stop_finishes_gracefully_and_closes_the_connection(): void
    {
        $consumer = $this->consumer();
        $this->publishEvent('user.deleted');
        $this->gateway->onFetch = fn (int $count) => $count === 2 ? $consumer->stop() : null;

        $stats = $consumer->run(new ConsumerRunOptions);

        $this->assertSame(1, $stats->handled);
        $this->assertSame('disconnect', end($this->gateway->calls));
        $this->assertFalse($this->gateway->connected);
        $this->assertFalse(Cache::get('auth.nats.connected'));
        $this->assertSame(['connected', 'stopped'], $this->states());
    }

    public function test_disabled_nats_exits_cleanly_in_once_mode_without_connecting(): void
    {
        $this->settings->current = new NatsSettings(enabled: false, url: 'nats://nats.test:4222', token: null);

        $stats = $this->runOnce();

        $this->assertSame(0, $stats->received);
        $this->assertSame(0, $this->gateway->connectCount);
        $this->assertSame(['disabled', 'stopped'], $this->states());
        $this->assertFalse(Cache::get('auth.nats.connected'));
        $this->assertNotNull(Cache::get('auth.nats.heartbeat_at'), 'the process still reports being alive');
    }

    public function test_a_disabled_consumer_does_not_need_the_pizzasys_driver_to_be_bound(): void
    {
        unset($this->app[IdentityInvalidator::class]);
        $this->settings->current = new NatsSettings(enabled: false, url: 'nats://nats.test:4222', token: null);

        $this->runOnce();

        $this->assertSame(['disabled', 'stopped'], $this->states());
    }

    public function test_unconfigured_nats_exits_cleanly_in_once_mode_without_connecting(): void
    {
        $this->settings->current = null;

        $this->runOnce();

        $this->assertSame(0, $this->gateway->connectCount);
        $this->assertSame(['unconfigured', 'stopped'], $this->states());
    }

    public function test_the_supervised_loop_idles_logging_once_per_state_change_and_never_crashes(): void
    {
        config(['nats.idle_poll_seconds' => 3]);
        $this->settings->current = new NatsSettings(enabled: false, url: 'nats://nats.test:4222', token: null);
        $consumer = $this->consumer();
        $this->clock->onSleep = function () use ($consumer): void {
            if (count($this->clock->sleeps) >= 7) {
                $consumer->stop();
            }
        };

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame(0, $this->gateway->connectCount);
        $this->assertSame(['disabled', 'stopped'], $this->states(), 'three idle cycles, one log line');
        $this->assertGreaterThanOrEqual(3, $this->settings->reads, 'settings are re-read every cycle');
        $this->assertSame(array_fill(0, 7, 1.0), $this->clock->sleeps, 'sleeps are sliced so a signal is honoured within a second');
    }

    public function test_an_idle_consumer_picks_up_settings_enabled_later_without_a_restart(): void
    {
        config(['nats.idle_poll_seconds' => 2]);
        $this->settings->current = new NatsSettings(enabled: false, url: 'nats://nats.test:4222', token: null);
        $consumer = $this->consumer();
        $this->clock->onSleep = function (): void {
            if (count($this->clock->sleeps) === 3) {
                $this->settings->current = new NatsSettings(enabled: true, url: 'nats://nats.test:4222', token: null);
            }
        };
        $this->gateway->onFetch = fn () => $consumer->stop();
        $this->publishEvent('role.updated');

        $consumer->run(new ConsumerRunOptions);

        $this->assertSame(1, $this->gateway->connectCount);
        $this->assertSame(['disabled', 'connected', 'stopped'], $this->states());
    }

    public function test_nothing_is_consumed_before_the_app_is_installed(): void
    {
        InstallStateFake::make(installed: false);

        $this->runOnce();

        $this->assertSame(0, $this->settings->reads, 'no settings (database) lookup before install');
        $this->assertSame(0, $this->gateway->connectCount);
        $this->assertSame(['not_installed', 'stopped'], $this->states());
    }

    /**
     * @return list<string>
     */
    private function states(): array
    {
        return array_map(
            static fn (array $record): string => (string) $record['context']['state'],
            $this->log->messages('nats.consumer.state'),
        );
    }
}
