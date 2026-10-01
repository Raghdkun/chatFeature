<?php

namespace App\Infrastructure\Nats;

use App\Infrastructure\Nats\Contracts\JetStreamGateway;
use Basis\Nats\Client;
use Basis\Nats\Configuration;
use Basis\Nats\Consumer\Configuration as ConsumerConfiguration;
use Basis\Nats\Message\Msg;
use Basis\Nats\Queue;
use Basis\Nats\Stream\RetentionPolicy;
use Basis\Nats\Stream\StorageBackend;
use Throwable;

/**
 * JetStreamGateway on top of basis-company/nats.
 *
 * The library's own pull-consumer helper (`Consumer::handle`) is not used: it blocks for a fixed window before it
 * hands anything back, accumulates pull requests and cannot nak with a delay. Instead this class sends its own
 * pull requests (`$JS.API.CONSUMER.MSG.NEXT.<stream>.<consumer>` with batch + expires, replies to a private inbox
 * subscription), keeps at most one pull outstanding, and returns as soon as a message arrived.
 *
 * The client's built-in reconnect is switched off: a broken socket surfaces as a GatewayException and the consumer
 * reconnects with its own backoff, re-ensuring the stream and consumer.
 */
final class BasisJetStreamGateway implements JetStreamGateway
{
    /** JetStream API error code "consumer not found". */
    private const ERR_CONSUMER_NOT_FOUND = 10014;

    /** Extra seconds to wait for the server's 408 after a pull's own expiry. */
    private const PULL_GRACE_SECONDS = 0.5;

    private ?Client $client = null;

    private ?Queue $inbox = null;

    private ?string $pullSubject = null;

    private ?float $pullIssuedAt = null;

    private ?float $pullExpiresAt = null;

    private int $pullRemaining = 0;

    public function connect(NatsSettings $settings): void
    {
        $this->disconnect();

        $endpoint = NatsEndpoint::parse((string) $settings->url);
        $token = $settings->token !== null && $settings->token !== '' ? $settings->token : null;

        try {
            $client = new Client(new Configuration(
                host: $endpoint->host,
                port: $endpoint->port,
                user: $token === null ? $endpoint->user : null,
                pass: $token === null ? $endpoint->password : null,
                token: $token,
                tlsCaFile: $settings->tlsCaFile,
                reconnect: false,
                timeout: 3.0,
            ));
            $client->setName('pne-chat-consumer');

            // The first PING completes INFO/CONNECT; bad credentials surface here as an -ERR.
            if (! $client->ping()) {
                throw new GatewayException('NATS did not answer the handshake PING.');
            }

            $this->client = $client;
        } catch (Throwable $exception) {
            throw $this->wrap($exception, 'Could not connect to NATS');
        }
    }

    public function disconnect(): void
    {
        $client = $this->client;
        $this->client = $this->inbox = $this->pullSubject = $this->pullIssuedAt = $this->pullExpiresAt = null;
        $this->pullRemaining = 0;

        if (! $client instanceof Client) {
            return;
        }

        try {
            $client->disconnect();
        } catch (Throwable) {
            try {
                $client->connection?->close();
            } catch (Throwable) {
                // Nothing left to release.
            }
        }
    }

    public function ensureStream(string $stream, string $subjectFilter, int $maxAgeSeconds): void
    {
        try {
            $handle = $this->client()->getApi()->getStream($stream);

            if ($handle->exists()) {
                return;
            }

            $handle->getConfiguration()
                ->setSubjects([$subjectFilter])
                ->setStorageBackend(StorageBackend::FILE)
                ->setRetentionPolicy(RetentionPolicy::LIMITS)
                ->setMaxAge($maxAgeSeconds * 1_000_000_000);
            $handle->create();
        } catch (Throwable $exception) {
            throw $this->wrap($exception, 'Could not ensure the JetStream stream');
        }
    }

    public function ensureConsumer(ConsumerSpec $spec): void
    {
        try {
            $client = $this->client();

            if (! $this->consumerExists($client, $spec)) {
                $configuration = (new ConsumerConfiguration($spec->stream, $spec->durable))
                    ->setAckPolicy('explicit')
                    ->setAckWait($spec->ackWaitSeconds * 1_000_000_000)
                    ->setDeliverPolicy($spec->deliverPolicy)
                    ->setMaxDeliver($spec->maxDeliver)
                    ->setSubjectFilter($spec->filter);

                $client->api('CONSUMER.DURABLE.CREATE.'.$spec->stream.'.'.$spec->durable, $configuration->toArray());
            }

            $this->pullSubject = '$JS.API.CONSUMER.MSG.NEXT.'.$spec->stream.'.'.$spec->durable;

            if (! $this->inbox instanceof Queue) {
                $subscription = $client->subscribe($client->configuration->inboxPrefix.'.pne-chat.'.bin2hex(random_bytes(8)));

                if (! $subscription instanceof Queue) {
                    throw new GatewayException('Could not subscribe to the pull inbox.');
                }

                // Non-blocking drain: waiting happens in fetch() through Client::process().
                $subscription->setTimeout(0.0);
                $this->inbox = $subscription;
            }
        } catch (Throwable $exception) {
            throw $this->wrap($exception, 'Could not ensure the JetStream consumer');
        }
    }

    public function fetch(int $batch, float $expiresSeconds): array
    {
        try {
            $client = $this->client();
            $inbox = $this->inbox;

            if (! $inbox instanceof Queue || $this->pullSubject === null) {
                throw new GatewayException('The consumer is not ensured; call ensureConsumer() first.');
            }

            // Deliveries that arrived while an API call (e.g. a periodic re-ensure) was waiting for its reply.
            $collected = $this->drain($inbox);

            if ($collected !== []) {
                return $collected;
            }

            if ($this->pullExpiresAt === null || microtime(true) >= $this->pullExpiresAt + self::PULL_GRACE_SECONDS) {
                $this->issuePull($client, $inbox, $batch, $expiresSeconds);
            }

            $deadline = ($this->pullExpiresAt ?? microtime(true)) + self::PULL_GRACE_SECONDS;

            while (microtime(true) < $deadline) {
                if ($client->process(max(0.05, min(1.0, $deadline - microtime(true)))) !== $inbox) {
                    continue;
                }

                $collected = $this->drain($inbox);

                if ($collected !== [] || $this->pullExpiresAt === null) {
                    break;
                }
            }

            if ($collected === [] && $this->pullIssuedAt !== null && microtime(true) - $this->pullIssuedAt < 0.2) {
                usleep(200_000);
            }

            return $collected;
        } catch (Throwable $exception) {
            throw $this->wrap($exception, 'Could not fetch from JetStream');
        }
    }

    public function ack(JetStreamMessage $message): void
    {
        $this->reply($message, static fn (Msg $delivery) => $delivery->ack());
    }

    public function nak(JetStreamMessage $message, float $delaySeconds = 0.0): void
    {
        $delay = $delaySeconds > 0
            ? ' '.json_encode(['delay' => (int) round($delaySeconds * 1_000_000_000)])
            : '';

        // Msg::nack() would encode the delay as a float; the server needs an integer number of nanoseconds.
        $this->reply($message, static fn (Msg $delivery) => $delivery->reply('-NAK'.$delay));
    }

    public function term(JetStreamMessage $message): void
    {
        $this->reply($message, static fn (Msg $delivery) => $delivery->term());
    }

    /**
     * @param  callable(Msg): mixed  $send
     */
    private function reply(JetStreamMessage $message, callable $send): void
    {
        if (! $message->handle instanceof Msg) {
            throw new GatewayException('The message does not belong to this connection.');
        }

        try {
            $send($message->handle);
        } catch (Throwable $exception) {
            throw $this->wrap($exception, 'Could not acknowledge the message');
        }
    }

    /**
     * Everything already buffered in the inbox, as deliveries (status frames only update the pull bookkeeping).
     *
     * @return list<JetStreamMessage>
     */
    private function drain(Queue $inbox): array
    {
        $messages = [];

        foreach ($inbox->fetchAll() as $delivery) {
            $message = $this->classify($delivery);

            if ($message instanceof JetStreamMessage) {
                $messages[] = $message;
            }
        }

        return $messages;
    }

    private function consumerExists(Client $client, ConsumerSpec $spec): bool
    {
        try {
            $client->api('CONSUMER.INFO.'.$spec->stream.'.'.$spec->durable);

            return true;
        } catch (Throwable $exception) {
            if ($exception->getCode() === self::ERR_CONSUMER_NOT_FOUND) {
                return false;
            }

            throw $exception;
        }
    }

    private function issuePull(Client $client, Queue $inbox, int $batch, float $expiresSeconds): void
    {
        $client->publish(
            (string) $this->pullSubject,
            ['batch' => $batch, 'expires' => (int) round($expiresSeconds * 1_000_000_000)],
            $inbox->subject,
        );

        $this->pullIssuedAt = microtime(true);
        $this->pullExpiresAt = $this->pullIssuedAt + $expiresSeconds;
        $this->pullRemaining = $batch;
    }

    /**
     * A real delivery has a `$JS.ACK.` reply subject; everything else is a status frame (404 no messages, 408 request
     * expired, 409 consumer problems, 100 idle heartbeat) which updates the pull bookkeeping.
     */
    private function classify(Msg $delivery): ?JetStreamMessage
    {
        if (str_starts_with((string) $delivery->replyTo, '$JS.ACK.')) {
            $this->pullRemaining--;

            if ($this->pullRemaining <= 0) {
                $this->pullExpiresAt = null;
            }

            $ack = JetStreamMessage::parseAckSubject($delivery->replyTo);

            return new JetStreamMessage($delivery->payload->body, $delivery->subject, $ack['deliveries'], $ack['stream_sequence'], $delivery);
        }

        $code = $delivery->payload->getHeader('Status-Code');
        $text = (string) $delivery->payload->getHeader('Status-Message');

        if ($code === '404' || $code === '408' || ($code === '409' && stripos($text, 'Batch Completed') !== false)) {
            $this->pullExpiresAt = null;
            $this->pullRemaining = 0;
        } elseif ($code === '409') {
            throw new GatewayException('JetStream rejected the pull request: '.$text);
        }

        return null;
    }

    private function client(): Client
    {
        return $this->client ?? throw new GatewayException('Not connected to NATS.');
    }

    private function wrap(Throwable $exception, string $context): GatewayException
    {
        if ($exception instanceof GatewayException) {
            return $exception;
        }

        return new GatewayException($context.': '.$exception->getMessage(), 0, $exception);
    }
}
