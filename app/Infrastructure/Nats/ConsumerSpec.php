<?php

namespace App\Infrastructure\Nats;

/**
 * The durable pull consumer this app owns on the pizzasys stream.
 */
final readonly class ConsumerSpec
{
    public function __construct(
        public string $stream,
        public string $durable,
        public string $filter,
        public int $maxDeliver,
        public int $ackWaitSeconds,
        public string $deliverPolicy,
    ) {}

    /**
     * `<prefix>-<APP_ENV>-<instance>`, reduced to characters JetStream accepts in a consumer name.
     */
    public static function durableName(string $prefix, string $appEnvironment, string $instance): string
    {
        return implode('-', array_filter(
            array_map(self::cleanPart(...), [$prefix, $appEnvironment, $instance]),
            static fn (string $part): bool => $part !== '',
        ));
    }

    /** Lower-case `[a-z0-9_-]` only; anything else collapses to a dash. */
    public static function cleanPart(string $part): string
    {
        return trim((string) preg_replace('/[^a-z0-9_-]+/', '-', strtolower($part)), '-');
    }
}
