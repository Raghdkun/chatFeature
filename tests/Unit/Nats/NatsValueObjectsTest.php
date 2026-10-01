<?php

namespace Tests\Unit\Nats;

use App\Infrastructure\Nats\Backoff;
use App\Infrastructure\Nats\ConsumerSpec;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\JetStreamMessage;
use App\Infrastructure\Nats\NatsEndpoint;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class NatsValueObjectsTest extends TestCase
{
    public function test_backoff_doubles_up_to_the_cap_with_equal_jitter(): void
    {
        $max = new Backoff(1.0, 10.0, static fn (): float => 1.0);
        $min = new Backoff(1.0, 10.0, static fn (): float => 0.0);

        $this->assertSame([1.0, 2.0, 4.0, 8.0, 10.0, 10.0], array_map(static fn () => $max->next(), range(1, 6)));
        $this->assertSame([0.5, 1.0, 2.0, 4.0, 5.0, 5.0], array_map(static fn () => $min->next(), range(1, 6)));
    }

    public function test_backoff_restarts_from_the_initial_delay_after_a_reset(): void
    {
        $backoff = new Backoff(1.0, 60.0, static fn (): float => 1.0);

        $backoff->next();
        $backoff->next();
        $backoff->next();
        $backoff->reset();

        $this->assertSame(1.0, $backoff->next());
    }

    public function test_backoff_default_jitter_stays_within_half_to_full_step(): void
    {
        $backoff = new Backoff(2.0, 60.0);

        for ($i = 0; $i < 50; $i++) {
            $backoff->reset();
            $delay = $backoff->next();
            $this->assertGreaterThanOrEqual(1.0, $delay);
            $this->assertLessThanOrEqual(2.0, $delay);
        }
    }

    /**
     * @return array<string, array{?string, int, int|null}>
     */
    public static function ackSubjects(): array
    {
        return [
            'modern with domain placeholder' => ['$JS.ACK._.ACC123.AUTH_EVENTS.pne-chat-prod-main.3.17.9.1759320000000000000.4.abcd1234', 3, 17],
            'modern with a JetStream domain' => ['$JS.ACK.hub.ACC123.AUTH_EVENTS.pne.1.5.5.1759320000000000000.0', 1, 5],
            'legacy nine tokens' => ['$JS.ACK.AUTH_EVENTS.pne.2.8.8.1759320000000000000.0', 2, 8],
            'null' => [null, 1, null],
            'not an ack subject' => ['_INBOX.abc', 1, null],
            'too few tokens' => ['$JS.ACK.a.b.c', 1, null],
            'non numeric counters' => ['$JS.ACK._.ACC.S.C.x.y.z.1.0.r', 1, null],
        ];
    }

    #[DataProvider('ackSubjects')]
    public function test_it_reads_delivery_count_and_stream_sequence_from_the_ack_subject(?string $subject, int $deliveries, ?int $sequence): void
    {
        $this->assertSame(['deliveries' => $deliveries, 'stream_sequence' => $sequence], JetStreamMessage::parseAckSubject($subject));
    }

    public function test_a_message_never_exposes_its_body_when_dumped(): void
    {
        $message = new JetStreamMessage('SECRET-BODY', 'auth.v1.user.updated', 2, 7);

        $this->assertStringNotContainsString('SECRET-BODY', print_r($message, true));
    }

    public function test_durable_names_follow_prefix_environment_and_instance(): void
    {
        $this->assertSame('pne-chat-production-main', ConsumerSpec::durableName('pne-chat', 'production', 'main'));
        $this->assertSame('pne-chat-testing-default', ConsumerSpec::durableName('pne-chat', 'testing', 'default'));
        $this->assertSame('pne-chat-staging-eu-west-1', ConsumerSpec::durableName('pne-chat', 'Staging', 'EU West.1'));
        $this->assertSame('pne-chat-local', ConsumerSpec::durableName('pne-chat', 'local', '***'), 'an empty part is dropped');
        $this->assertSame('', ConsumerSpec::cleanPart('*.>'));
    }

    /**
     * @return array<string, array{string, string, int, ?string, ?string}>
     */
    public static function endpoints(): array
    {
        return [
            'full url' => ['nats://nats.internal:4223', 'nats.internal', 4223, null, null],
            'default port' => ['nats://nats.internal', 'nats.internal', 4222, null, null],
            'tls scheme' => ['tls://nats.example.com:4222', 'nats.example.com', 4222, null, null],
            'bare host' => ['nats.internal', 'nats.internal', 4222, null, null],
            'bare host and port' => ['127.0.0.1:4333', '127.0.0.1', 4333, null, null],
            'userinfo' => ['nats://svc:p%40ss@nats.internal:4222', 'nats.internal', 4222, 'svc', 'p@ss'],
            'whitespace' => ["  nats://nats.internal:4222\n", 'nats.internal', 4222, null, null],
        ];
    }

    #[DataProvider('endpoints')]
    public function test_it_parses_nats_urls(string $url, string $host, int $port, ?string $user, ?string $password): void
    {
        $endpoint = NatsEndpoint::parse($url);

        $this->assertSame([$host, $port, $user, $password], [$endpoint->host, $endpoint->port, $endpoint->user, $endpoint->password]);
    }

    public function test_it_rejects_unusable_urls(): void
    {
        foreach (['', '   ', 'nats://', 'nats://:4222'] as $url) {
            try {
                NatsEndpoint::parse($url);
                $this->fail("Expected a GatewayException for [{$url}].");
            } catch (GatewayException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
