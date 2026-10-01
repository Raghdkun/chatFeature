<?php

namespace Tests\Feature\Nats;

use App\Infrastructure\Nats\BasisJetStreamGateway;
use App\Infrastructure\Nats\ConsumerSpec;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\NatsSettings;
use RuntimeException;
use Tests\TestCase;

/**
 * Drives the REAL BasisJetStreamGateway (and basis-company/nats under it) over a TCP socket against
 * tests/Support/Nats/stub-nats-server.php, a protocol model of NATS + JetStream. It proves the wire handling:
 * auth, stream/consumer ensure (create once, never alter), long-poll pulls with a single outstanding request,
 * status frames, ack/nak(with integer-nanosecond delay)/term. The real-server check is NatsIntegrationTest.
 */
class BasisJetStreamGatewayTest extends TestCase
{
    /** @var resource|null */
    private $process = null;

    private string $logFile;

    private string $scenarioFile;

    private int $port = 0;

    protected function setUp(): void
    {
        parent::setUp();

        $this->logFile = storage_path('framework/testing/nats-stub-'.bin2hex(random_bytes(4)).'.log');
        $this->scenarioFile = $this->logFile.'.json';
        @mkdir(dirname($this->logFile), 0775, true);
    }

    protected function tearDown(): void
    {
        if (is_resource($this->process)) {
            proc_terminate($this->process);
            proc_close($this->process);
        }

        @unlink($this->logFile);
        @unlink($this->scenarioFile);

        parent::tearDown();
    }

    public function test_it_ensures_the_stream_and_consumer_once_then_pulls_acks_naks_and_terminates(): void
    {
        $this->startStub(['token' => 'stub-token', 'messages' => [
            ['subject' => 'auth.v1.user.deleted', 'body' => '{"n":1}'],
            ['subject' => 'auth.v1.role.updated', 'body' => '{"n":2}'],
            ['subject' => 'auth.v1.store.created', 'body' => '{"n":3}'],
        ]]);
        $gateway = new BasisJetStreamGateway;

        $gateway->connect($this->settings('stub-token'));
        $this->assertContains('CONNECT headers=1 token=stub-token', $this->log());

        $gateway->ensureStream('AUTH_EVENTS', 'auth.v1.>', 30 * 86_400);
        $gateway->ensureStream('AUTH_EVENTS', 'auth.v1.>', 30 * 86_400);
        $streamConfig = json_decode($this->logged('STREAM_CONFIG')[0], true);
        $this->assertCount(1, $this->logged('API STREAM.CREATE.AUTH_EVENTS'), 'an existing stream is left alone');
        $this->assertSame(['auth.v1.>'], $streamConfig['subjects']);
        $this->assertSame('file', $streamConfig['storage']);
        $this->assertSame('limits', $streamConfig['retention']);
        $this->assertSame(30 * 86_400 * 1_000_000_000, $streamConfig['max_age']);

        $spec = new ConsumerSpec('AUTH_EVENTS', 'pne-chat-testing-default', 'auth.v1.>', 5, 30, 'new');
        $gateway->ensureConsumer($spec);
        $gateway->ensureConsumer($spec);
        $consumerConfig = json_decode($this->logged('CONSUMER_CONFIG')[0], true)['config'];
        $this->assertCount(1, $this->logged('API CONSUMER.DURABLE.CREATE.AUTH_EVENTS.pne-chat-testing-default'), 'an existing consumer is left alone');
        $this->assertSame('pne-chat-testing-default', $consumerConfig['durable_name']);
        $this->assertSame('explicit', $consumerConfig['ack_policy']);
        $this->assertSame(5, $consumerConfig['max_deliver']);
        $this->assertSame(30_000_000_000, $consumerConfig['ack_wait']);
        $this->assertSame('new', $consumerConfig['deliver_policy']);
        $this->assertSame('auth.v1.>', $consumerConfig['filter_subject']);

        $messages = $gateway->fetch(50, 2.5);

        $this->assertCount(3, $messages);
        $this->assertSame(['{"n":1}', '{"n":2}', '{"n":3}'], array_map(fn ($m) => $m->body, $messages));
        $this->assertSame(['auth.v1.user.deleted', 'auth.v1.role.updated', 'auth.v1.store.created'], array_map(fn ($m) => $m->subject, $messages));
        $this->assertSame([1, 1, 1], array_map(fn ($m) => $m->deliveries, $messages));
        $this->assertSame([1, 2, 3], array_map(fn ($m) => $m->streamSequence, $messages));
        $this->assertSame(['PULL batch=50 expires=2500000000'], $this->logged('PULL'));

        $gateway->ack($messages[0]);
        $gateway->nak($messages[1], 2.0);
        $gateway->term($messages[2]);

        $redelivered = $gateway->fetch(50, 2.5);

        $this->assertCount(1, $redelivered, 'the nak\'d message comes back on the pull that is still outstanding');
        $this->assertSame('{"n":2}', $redelivered[0]->body);
        $this->assertSame(2, $redelivered[0]->deliveries);
        $this->assertSame(['PULL batch=50 expires=2500000000'], $this->logged('PULL'), 'no second pull while one is outstanding');

        $this->assertSame(['ACK 1 deliveries=1'], $this->logged('ACK'));
        $this->assertSame(['NAK 2 {"delay":2000000000}'], $this->logged('NAK'));
        $this->assertSame(['TERM 3'], $this->logged('TERM'));

        $gateway->ack($redelivered[0]);

        $this->assertSame([], $gateway->fetch(50, 2.5), 'the 408 at the end of the pull ends the long poll with nothing');
        $this->assertSame([], $gateway->fetch(50, 0.5), 'the next fetch issues a fresh pull');
        $this->assertCount(2, $this->logged('PULL'));
        $this->assertSame('PULL batch=50 expires=500000000', $this->logged('PULL')[1]);

        $gateway->disconnect();

        $this->expectException(GatewayException::class);
        $gateway->fetch(50, 0.5);
    }

    public function test_a_message_that_arrives_during_a_pull_is_returned_at_once_not_after_the_expiry(): void
    {
        $this->startStub(['token' => null, 'stream_exists' => true, 'consumer_exists' => true, 'late' => [
            ['after' => 0.6, 'subject' => 'auth.v1.user.deleted', 'body' => '{"late":true}'],
        ]]);
        $gateway = new BasisJetStreamGateway;
        $gateway->connect($this->settings(null));
        $gateway->ensureStream('AUTH_EVENTS', 'auth.v1.>', 86_400);
        $gateway->ensureConsumer(new ConsumerSpec('AUTH_EVENTS', 'pne-chat-testing-default', 'auth.v1.>', 5, 30, 'new'));

        $started = microtime(true);
        $messages = $gateway->fetch(10, 5.0);
        $elapsed = microtime(true) - $started;

        $this->assertCount(1, $messages);
        $this->assertSame('{"late":true}', $messages[0]->body);
        $this->assertLessThan(3.0, $elapsed, 'the long poll returns when data arrives');
        $this->assertSame([], $this->logged('API STREAM.CREATE.AUTH_EVENTS'));
        $this->assertSame([], $this->logged('API CONSUMER.DURABLE.CREATE.AUTH_EVENTS.pne-chat-testing-default'));
        $gateway->disconnect();
    }

    public function test_a_delivery_that_arrives_while_an_api_call_waits_is_not_stranded(): void
    {
        $this->startStub(['token' => null, 'stream_exists' => true, 'consumer_exists' => true, 'messages' => [
            ['subject' => 'auth.v1.user.deleted', 'body' => '{"n":1}'],
        ], 'push_before_info_reply' => [
            ['subject' => 'auth.v1.role.updated', 'body' => '{"during":"api"}'],
        ]]);
        $spec = new ConsumerSpec('AUTH_EVENTS', 'pne-chat-testing-default', 'auth.v1.>', 5, 30, 'new');
        $gateway = new BasisJetStreamGateway;
        $gateway->connect($this->settings(null));
        $gateway->ensureStream('AUTH_EVENTS', 'auth.v1.>', 86_400);
        $gateway->ensureConsumer($spec);

        $this->assertCount(1, $gateway->fetch(50, 10.0));

        $gateway->ensureConsumer($spec);
        $started = microtime(true);
        $messages = $gateway->fetch(50, 10.0);

        $this->assertCount(1, $messages);
        $this->assertSame('{"during":"api"}', $messages[0]->body);
        $this->assertLessThan(2.0, microtime(true) - $started, 'buffered deliveries are returned without waiting for the pull to expire');
        $gateway->disconnect();
    }

    public function test_bad_credentials_surface_as_a_gateway_exception(): void
    {
        $this->startStub(['token' => 'right-token']);

        try {
            (new BasisJetStreamGateway)->connect($this->settings('wrong-token'));
            $this->fail('A rejected token must not look like a successful connection.');
        } catch (GatewayException $exception) {
            $this->assertStringContainsString('Authorization Violation', $exception->getMessage());
        }
    }

    public function test_an_unreachable_server_is_a_gateway_exception(): void
    {
        $probe = stream_socket_server('tcp://127.0.0.1:0');
        $port = (int) explode(':', (string) stream_socket_get_name($probe, false))[1];
        fclose($probe);

        $this->expectException(GatewayException::class);
        $this->expectExceptionMessage('Could not connect to NATS');

        (new BasisJetStreamGateway)->connect(new NatsSettings(enabled: true, url: 'nats://127.0.0.1:'.$port, token: null));
    }

    public function test_using_the_gateway_before_connecting_is_an_error(): void
    {
        $this->expectException(GatewayException::class);

        (new BasisJetStreamGateway)->fetch(1, 0.1);
    }

    /**
     * @param  array<string, mixed>  $scenario
     */
    private function startStub(array $scenario): void
    {
        file_put_contents($this->scenarioFile, json_encode($scenario + ['idle_exit' => 20]));
        touch($this->logFile);

        $process = proc_open(
            [PHP_BINARY, dirname(__DIR__, 2).'/Support/Nats/stub-nats-server.php', $this->scenarioFile, $this->logFile],
            [1 => ['pipe', 'w'], 2 => ['pipe', 'w']],
            $pipes,
        );

        if (! is_resource($process)) {
            throw new RuntimeException('Could not start the NATS stub server.');
        }

        $this->process = $process;
        stream_set_timeout($pipes[1], 10);
        $line = (string) fgets($pipes[1]);

        if (! preg_match('/^PORT (\d+)/', $line, $matches)) {
            throw new RuntimeException('The NATS stub server did not start: '.stream_get_contents($pipes[2]));
        }

        $this->port = (int) $matches[1];
    }

    private function settings(?string $token): NatsSettings
    {
        return new NatsSettings(enabled: true, url: 'nats://127.0.0.1:'.$this->port, token: $token);
    }

    /**
     * Everything the stub saw, waiting briefly for in-flight frames.
     *
     * @return list<string>
     */
    private function log(): array
    {
        usleep(150_000);

        return array_values(array_filter(explode("\n", (string) file_get_contents($this->logFile))));
    }

    /**
     * The detail of every log line of this kind, e.g. logged('ACK') => ['ACK 1 deliveries=1'] (whole lines);
     * for kinds that carry a payload after the verb (STREAM_CONFIG, CONSUMER_CONFIG) only the payload.
     *
     * @return list<string>
     */
    private function logged(string $kind): array
    {
        $payloadKinds = ['STREAM_CONFIG', 'CONSUMER_CONFIG'];

        $lines = array_values(array_filter($this->log(), fn (string $line): bool => $line === $kind || str_starts_with($line, $kind.' ')));

        return in_array($kind, $payloadKinds, true)
            ? array_map(fn (string $line): string => substr($line, strlen($kind) + 1), $lines)
            : $lines;
    }
}
