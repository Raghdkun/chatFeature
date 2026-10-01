<?php

namespace Tests\Support\Nats;

use App\Infrastructure\Nats\ConsumerSpec;
use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\JetStreamMessage;
use App\Infrastructure\Nats\NatsSettings;
use Closure;

/**
 * In-memory JetStream: a queue of deliveries with ack/nak/term bookkeeping. A nak re-queues the message at once
 * with deliveries + 1 (the requested delay is recorded, not waited for); an empty long poll "waits" on the fake clock.
 */
final class FakeJetStreamGateway implements JetStreamGateway
{
    /** @var list<string> */
    public array $calls = [];

    public bool $connected = false;

    public int $connectCount = 0;

    public int $failConnects = 0;

    public ?NatsSettings $settings = null;

    public ?ConsumerSpec $consumer = null;

    /** @var list<array{string, string, int}> stream, filter, max age seconds */
    public array $streamsEnsured = [];

    public int $consumerEnsures = 0;

    /** @var list<array{int, float}> batch, expires per fetch */
    public array $fetches = [];

    /** @var list<int> how many fetches had happened when each connect() was called */
    public array $fetchCountAtConnect = [];

    /** @var list<int> ids */
    public array $acked = [];

    /** @var list<array{int, float}> id, delay */
    public array $nakked = [];

    /** @var list<int> ids */
    public array $termed = [];

    /** @var (Closure(int, self): void)|null runs at the start of every fetch (1-based count); may throw */
    public ?Closure $onFetch = null;

    /** @var list<array{id: int, body: string, subject: string, deliveries: int, sequence: int}> */
    private array $pending = [];

    /** @var array<int, array{id: int, body: string, subject: string, deliveries: int, sequence: int}> */
    private array $inflight = [];

    private int $nextId = 1;

    public function __construct(private readonly FakeClock $clock) {}

    /**
     * Queue a message; returns its id (stable across redeliveries).
     */
    public function publish(string $body, string $subject = 'auth.v1.test'): int
    {
        $id = $this->nextId++;
        $this->pending[] = ['id' => $id, 'body' => $body, 'subject' => $subject, 'deliveries' => 0, 'sequence' => $id];

        return $id;
    }

    public function pendingCount(): int
    {
        return count($this->pending);
    }

    public function connect(NatsSettings $settings): void
    {
        $this->calls[] = 'connect';
        $this->connectCount++;
        $this->fetchCountAtConnect[] = count($this->fetches);

        if ($this->failConnects > 0) {
            $this->failConnects--;

            throw new GatewayException('Could not connect to NATS: simulated outage');
        }

        $this->settings = $settings;
        $this->connected = true;
    }

    public function disconnect(): void
    {
        $this->calls[] = 'disconnect';
        $this->connected = false;
    }

    public function ensureStream(string $stream, string $subjectFilter, int $maxAgeSeconds): void
    {
        $this->calls[] = 'ensureStream';
        $this->streamsEnsured[] = [$stream, $subjectFilter, $maxAgeSeconds];
    }

    public function ensureConsumer(ConsumerSpec $spec): void
    {
        $this->calls[] = 'ensureConsumer';
        $this->consumerEnsures++;
        $this->consumer = $spec;
    }

    public function fetch(int $batch, float $expiresSeconds): array
    {
        $this->calls[] = 'fetch';
        $this->fetches[] = [$batch, $expiresSeconds];

        if ($this->onFetch instanceof Closure) {
            ($this->onFetch)(count($this->fetches), $this);
        }

        if ($this->pending === []) {
            $this->clock->sleep($expiresSeconds);

            return [];
        }

        $messages = [];

        foreach (array_splice($this->pending, 0, $batch) as $entry) {
            $entry['deliveries']++;
            $this->inflight[$entry['id']] = $entry;
            $messages[] = new JetStreamMessage($entry['body'], $entry['subject'], $entry['deliveries'], $entry['sequence'], $entry['id']);
        }

        return $messages;
    }

    public function ack(JetStreamMessage $message): void
    {
        $this->calls[] = 'ack';
        $this->acked[] = (int) $message->handle;
        unset($this->inflight[(int) $message->handle]);
    }

    public function nak(JetStreamMessage $message, float $delaySeconds = 0.0): void
    {
        $this->calls[] = 'nak';
        $id = (int) $message->handle;
        $this->nakked[] = [$id, $delaySeconds];
        $this->pending[] = $this->inflight[$id];
        unset($this->inflight[$id]);
    }

    public function term(JetStreamMessage $message): void
    {
        $this->calls[] = 'term';
        $this->termed[] = (int) $message->handle;
        unset($this->inflight[(int) $message->handle]);
    }
}
