<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use Carbon\CarbonImmutable;

/** `201 {messageId, timestamp}` of a send: the message was accepted (not delivered), `timestamp` is epoch seconds. */
final readonly class OpenWaSendResult
{
    public function __construct(
        public string $messageId,
        public CarbonImmutable $timestamp,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload
     *
     * @throws OpenWaUnavailable when there is no message id in it
     */
    public static function fromArray(array $payload): self
    {
        $id = $payload['messageId'] ?? null;

        if (! is_string($id) || $id === '') {
            throw new OpenWaUnavailable('OpenWA accepted the message but returned no message id.');
        }

        $timestamp = $payload['timestamp'] ?? null;

        return new self($id, is_numeric($timestamp) ? CarbonImmutable::createFromTimestampUTC((int) $timestamp) : CarbonImmutable::now());
    }
}
