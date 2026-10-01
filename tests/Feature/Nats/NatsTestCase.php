<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\ConsumerRunOptions;
use App\Infrastructure\Nats\ConsumerStats;
use App\Infrastructure\Nats\Contracts\Clock;
use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\NatsConsumer;
use App\Infrastructure\Nats\NatsSettings;
use App\Models\ProcessedEvent;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Tests\Support\Nats\FakeClock;
use Tests\Support\Nats\FakeJetStreamGateway;
use Tests\Support\Nats\FakeNatsSettingsProvider;
use Tests\Support\Nats\LogRecorder;
use Tests\Support\Nats\NatsFixtures;
use Tests\Support\Nats\RecordingIdentityInvalidator;
use Tests\TestCase;

/**
 * Wires the consumer to an in-memory JetStream, a virtual clock, a recording invalidator and a recording logger.
 */
abstract class NatsTestCase extends TestCase
{
    use RefreshDatabase;

    /** Stands in for a password hash: must never show up in logs, the ledger or the dead-letter file. */
    public const SECRET = '$2y$12$SECRET-SENTINEL-must-never-be-persisted';

    protected FakeClock $clock;

    protected FakeJetStreamGateway $gateway;

    protected RecordingIdentityInvalidator $invalidator;

    protected FakeNatsSettingsProvider $settings;

    protected LogRecorder $log;

    protected string $deadLetterPath;

    protected function setUp(): void
    {
        parent::setUp();

        $this->clock = new FakeClock(CarbonImmutable::parse('2026-10-01T12:00:00+00:00'));
        $this->gateway = new FakeJetStreamGateway($this->clock);
        $this->invalidator = new RecordingIdentityInvalidator;
        $this->settings = new FakeNatsSettingsProvider(new NatsSettings(enabled: true, url: 'nats://nats.test:4222', token: 'test-token'));
        $this->log = LogRecorder::install();
        $this->deadLetterPath = storage_path('framework/testing/nats-dead-letter-'.bin2hex(random_bytes(4)).'.ndjson');

        $this->app->instance(Clock::class, $this->clock);
        $this->app->instance(JetStreamGateway::class, $this->gateway);
        $this->app->instance(IdentityInvalidator::class, $this->invalidator);
        $this->app->instance(NatsSettingsProvider::class, $this->settings);

        config(['nats.dead_letter_path' => $this->deadLetterPath]);
    }

    protected function tearDown(): void
    {
        File::delete($this->deadLetterPath);

        parent::tearDown();
    }

    protected function consumer(): NatsConsumer
    {
        return $this->app->make(NatsConsumer::class);
    }

    protected function runOnce(?NatsConsumer $consumer = null, ?int $maxMessages = null): ConsumerStats
    {
        return ($consumer ?? $this->consumer())->run(new ConsumerRunOptions(once: true, maxMessages: $maxMessages));
    }

    /**
     * Queue a fixture event of this type (short or full name) on its real subject; returns the message id.
     *
     * @param  array<string, mixed>  $overrides  merged over the envelope
     */
    protected function publishEvent(string $type, array $overrides = []): int
    {
        $full = str_starts_with($type, 'auth.v1.') ? $type : 'auth.v1.'.$type;

        return $this->gateway->publish(NatsFixtures::json($full, $overrides), $full);
    }

    /**
     * @return list<array<string, mixed>> the decoded lines of the dead-letter file
     */
    protected function deadLetters(): array
    {
        if (! is_file($this->deadLetterPath)) {
            return [];
        }

        return array_map(
            static fn (string $line): array => json_decode($line, true, 512, JSON_THROW_ON_ERROR),
            array_values(array_filter(explode("\n", (string) file_get_contents($this->deadLetterPath)))),
        );
    }

    /** Everything that could leak a payload: logs, the dead-letter file and the idempotency ledger. */
    protected function assertNoSecretPersisted(): void
    {
        $ledger = json_encode(ProcessedEvent::query()->get()->toArray(), JSON_THROW_ON_ERROR);
        $deadLetter = is_file($this->deadLetterPath) ? (string) file_get_contents($this->deadLetterPath) : '';

        foreach ([$this->log->dump(), $deadLetter, $ledger] as $haystack) {
            $this->assertStringNotContainsString('SECRET-SENTINEL', $haystack);
            $this->assertStringNotContainsString('$2y$', $haystack);
        }
    }
}
