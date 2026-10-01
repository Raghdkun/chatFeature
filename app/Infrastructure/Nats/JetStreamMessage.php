<?php

namespace App\Infrastructure\Nats;

/**
 * One JetStream delivery. `body` is the raw payload and must never be logged or persisted outside the handler
 * path; `handle` is an opaque token the gateway uses to ack/nak/term this exact delivery.
 */
final readonly class JetStreamMessage
{
    public function __construct(
        public string $body,
        public string $subject,
        public int $deliveries = 1,
        public ?int $streamSequence = null,
        public mixed $handle = null,
    ) {}

    /**
     * Parse the JetStream ack reply subject: `$JS.ACK.<stream>.<consumer>.<delivered>.<sseq>.<dseq>.<ts>.<pending>`
     * (9 tokens, pre-2.9) or `$JS.ACK.<domain>.<acchash>.<stream>.<consumer>.<delivered>.<sseq>.<dseq>.<ts>.<pending>[.<rand>]`.
     *
     * @return array{deliveries: int, stream_sequence: int|null}
     */
    public static function parseAckSubject(?string $replyTo): array
    {
        $unknown = ['deliveries' => 1, 'stream_sequence' => null];

        if ($replyTo === null || ! str_starts_with($replyTo, '$JS.ACK.')) {
            return $unknown;
        }

        $tokens = explode('.', $replyTo);
        $count = count($tokens);

        if ($count === 9) {
            [$delivered, $sequence] = [$tokens[4], $tokens[5]];
        } elseif ($count >= 11) {
            [$delivered, $sequence] = [$tokens[6], $tokens[7]];
        } else {
            return $unknown;
        }

        if (! ctype_digit($delivered) || ! ctype_digit($sequence)) {
            return $unknown;
        }

        return ['deliveries' => max(1, (int) $delivered), 'stream_sequence' => (int) $sequence];
    }

    /**
     * @return array{subject: string, deliveries: int, stream_sequence: int|null}
     */
    public function __debugInfo(): array
    {
        return ['subject' => $this->subject, 'deliveries' => $this->deliveries, 'stream_sequence' => $this->streamSequence];
    }
}
