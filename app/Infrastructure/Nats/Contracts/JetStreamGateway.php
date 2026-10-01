<?php

namespace App\Infrastructure\Nats\Contracts;

use App\Infrastructure\Nats\BasisJetStreamGateway;
use App\Infrastructure\Nats\ConsumerSpec;
use App\Infrastructure\Nats\GatewayException;
use App\Infrastructure\Nats\JetStreamMessage;
use App\Infrastructure\Nats\NatsSettings;
use Illuminate\Container\Attributes\Bind;

/**
 * All NATS/JetStream I/O the consumer needs, so everything above it is testable with an in-memory fake.
 * Every method throws GatewayException when the server cannot be reached or rejects the request.
 */
#[Bind(BasisJetStreamGateway::class)]
interface JetStreamGateway
{
    /**
     * Open a fresh connection (closing any previous one) and prove the handshake worked.
     *
     * @throws GatewayException
     */
    public function connect(NatsSettings $settings): void;

    public function disconnect(): void;

    /**
     * Create the stream (file storage, limits retention) only when it does not exist; never alters an existing one.
     *
     * @throws GatewayException
     */
    public function ensureStream(string $stream, string $subjectFilter, int $maxAgeSeconds): void;

    /**
     * Create the durable explicit-ack pull consumer only when it does not exist; never alters an existing one.
     *
     * @throws GatewayException
     */
    public function ensureConsumer(ConsumerSpec $spec): void;

    /**
     * Long-poll for up to `$expiresSeconds`; returns as soon as at least one message arrived (at most `$batch`),
     * or an empty list when the poll expired.
     *
     * @return list<JetStreamMessage>
     *
     * @throws GatewayException
     */
    public function fetch(int $batch, float $expiresSeconds): array;

    public function ack(JetStreamMessage $message): void;

    /** Ask for redelivery after `$delaySeconds`. */
    public function nak(JetStreamMessage $message, float $delaySeconds = 0.0): void;

    /** Never redeliver this message. */
    public function term(JetStreamMessage $message): void;
}
