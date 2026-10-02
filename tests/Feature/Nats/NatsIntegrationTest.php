<?php

namespace Tests\Feature\Nats;

use App\Auth\Pizzasys\Contracts\IdentityInvalidator;
use App\Infrastructure\Nats\BasisJetStreamGateway;
use App\Infrastructure\Nats\ConsumerRunOptions;
use App\Infrastructure\Nats\ConsumerStats;
use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\NatsConsumer;
use App\Infrastructure\Nats\NatsSettings;
use App\Models\ProcessedEvent;
use Basis\Nats\Client;
use Basis\Nats\Configuration;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use PHPUnit\Framework\Attributes\Group;
use RuntimeException;
use Tests\Support\Nats\FakeNatsSettingsProvider;
use Tests\Support\Nats\NatsFixtures;
use Tests\Support\Nats\RecordingIdentityInvalidator;
use Tests\TestCase;
use Throwable;

/**
 * End-to-end check of the REAL BasisJetStreamGateway against a real NATS server with JetStream. Skipped unless
 * NATS_TEST_URL is set; it creates (and removes) its own uniquely named stream and subjects, so it is safe on a
 * shared dev server.
 *
 *   docker compose -f docker/compose.dev.yml --profile nats up -d        # nats:2.11 with -js on :4222
 *   NATS_TEST_URL=nats://127.0.0.1:4222 php artisan test --filter=NatsIntegrationTest
 *   # optional: NATS_TEST_TOKEN=<token> when the server requires one
 *
 * What it proves: stream + durable consumer creation, long-poll fetch, ack, redelivery after a nak with delay,
 * term of a malformed body, envelope-id idempotency, and that nothing stays pending/unacked on the server.
 */
#[Group('nats-integration')]
class NatsIntegrationTest extends TestCase
{
    use RefreshDatabase;

    private Client $admin;

    private string $stream;

    private string $subjectPrefix;

    private RecordingIdentityInvalidator $invalidator;

    private string $deadLetterPath;

    protected function setUp(): void
    {
        parent::setUp();

        $url = getenv('NATS_TEST_URL');

        if (! is_string($url) || $url === '') {
            $this->markTestSkipped('Set NATS_TEST_URL=nats://127.0.0.1:4222 (a server running with -js) to run the real-NATS integration test.');
        }

        // A dev NATS on loopback is a private-network target: allowed here the way PORTAL_ALLOW_PRIVATE_HOSTS=true does.
        config(['chat.portal_allow_private_hosts' => true]);

        $parts = parse_url($url);
        $token = getenv('NATS_TEST_TOKEN');
        $suffix = bin2hex(random_bytes(4));
        $this->stream = 'AUTH_EVENTS_IT_'.strtoupper($suffix);
        $this->subjectPrefix = 'auth.v1.it'.$suffix;
        $this->deadLetterPath = storage_path('framework/testing/nats-it-'.$suffix.'.ndjson');

        $this->admin = new Client(new Configuration(
            host: (string) ($parts['host'] ?? '127.0.0.1'),
            port: (int) ($parts['port'] ?? 4222),
            token: is_string($token) && $token !== '' ? $token : null,
            timeout: 3.0,
        ));

        $this->invalidator = new RecordingIdentityInvalidator;
        $this->app->instance(IdentityInvalidator::class, $this->invalidator);
        $this->app->bind(JetStreamGateway::class, BasisJetStreamGateway::class);
        $this->app->instance(NatsSettingsProvider::class, new FakeNatsSettingsProvider(new NatsSettings(
            enabled: true,
            url: $url,
            token: is_string($token) && $token !== '' ? $token : null,
            stream: $this->stream,
            ensureStream: true,
        )));

        config([
            'nats.subject_filter' => $this->subjectPrefix.'.>',
            'nats.consumer.deliver_policy' => 'all',
            'nats.consumer.nak_delays' => [1],
            'nats.dead_letter_path' => $this->deadLetterPath,
        ]);
    }

    protected function tearDown(): void
    {
        if (isset($this->admin)) {
            try {
                $this->admin->getApi()->getStream($this->stream)->delete();
            } catch (Throwable) {
                // Best effort cleanup.
            }
        }

        if (isset($this->deadLetterPath)) {
            File::delete($this->deadLetterPath);
        }

        parent::tearDown();
    }

    public function test_events_published_to_a_real_stream_are_consumed_acked_and_deduplicated(): void
    {
        $this->consume(new ConsumerRunOptions(once: true));
        $this->assertTrue($this->admin->getApi()->getStream($this->stream)->exists(), 'the stream was created');

        $deleted = NatsFixtures::json('user.deleted');
        $this->publish('user.deleted', $deleted);
        $this->publish('user.deleted', $deleted);
        $this->publish('role.updated', NatsFixtures::json('role.updated'));
        $this->publish('user.updated', 'not json at all');
        $this->publish('widget.exploded', NatsFixtures::json('user.created', ['id' => NatsFixtures::ulid(), 'type' => 'auth.v1.widget.exploded']));

        $stats = $this->consume(new ConsumerRunOptions(once: true));

        $this->assertSame(5, $stats->received);
        $this->assertSame(2, $stats->handled);
        $this->assertSame(1, $stats->duplicates);
        $this->assertSame(1, $stats->malformed);
        $this->assertSame(1, $stats->unknown);
        $this->assertSame([['deactivateExternalId', '10'], ['flushAll', null]], $this->invalidator->calls);
        // One row per event that reached the processor: the two handled ones and the unknown type. A payload that is not JSON has no
        // envelope id, so it is counted as malformed and terminated without a row; the duplicate is the same row as its first delivery.
        $this->assertSame(3, ProcessedEvent::query()->count());

        $consumer = $this->admin->getApi()->getStream($this->stream)->getConsumer('pne-chat-testing-default')->info();
        $this->assertSame(0, $consumer->num_ack_pending, 'every delivery was acked or terminated');
        $this->assertSame(0, $consumer->num_pending, 'nothing is left to deliver');
    }

    public function test_a_failed_event_is_redelivered_after_the_nak_delay(): void
    {
        $this->consume(new ConsumerRunOptions(once: true));

        $failures = 1;
        $this->invalidator->beforeCall = function () use (&$failures): void {
            if ($failures-- > 0) {
                throw new RuntimeException('simulated transient failure');
            }
        };
        $this->publish('user.deleted', NatsFixtures::json('user.deleted'));

        $stats = $this->consume(new ConsumerRunOptions(maxMessages: 2));

        $this->assertSame(2, $stats->received, 'the same message arrived twice');
        $this->assertSame(1, $stats->failed);
        $this->assertSame(1, $stats->handled);
        $this->assertSame([['deactivateExternalId', '10']], $this->invalidator->calls);
    }

    private function publish(string $name, string $body): void
    {
        $this->admin->publish($this->subjectPrefix.'.'.$name, $body);
        $this->admin->ping();
    }

    private function consume(ConsumerRunOptions $options): ConsumerStats
    {
        return $this->app->make(NatsConsumer::class)->run($options);
    }
}
