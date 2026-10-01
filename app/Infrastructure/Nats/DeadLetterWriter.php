<?php

namespace App\Infrastructure\Nats;

use App\Infrastructure\Nats\Contracts\Clock;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Appends one metadata-only line per event that could not be processed to `storage/logs/nats-dead-letter.ndjson`.
 * The signature only accepts identifiers and counters on purpose: the payload (which can hold a password hash) is
 * never written. To inspect the original event, fetch the stream sequence from JetStream (`nats stream get`).
 */
final class DeadLetterWriter
{
    public function __construct(
        private readonly Repository $config,
        private readonly Clock $clock,
    ) {}

    public function write(
        string $reason,
        ?string $eventId,
        ?string $type,
        string $subject,
        ?int $streamSequence,
        int $deliveries,
        ?string $error = null,
    ): void {
        $path = $this->config->get('nats.dead_letter_path');

        if (! is_string($path) || $path === '') {
            return;
        }

        $line = json_encode([
            'at' => $this->clock->now()->toIso8601String(),
            'reason' => $reason,
            'event_id' => $eventId,
            'type' => $type === null ? null : substr($type, 0, 128),
            'subject' => substr($subject, 0, 128),
            'stream_sequence' => $streamSequence,
            'deliveries' => $deliveries,
            'error' => $error,
        ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        try {
            File::ensureDirectoryExists(dirname($path));
            file_put_contents($path, $line."\n", FILE_APPEND | LOCK_EX);
        } catch (Throwable $exception) {
            Log::error('nats.dead_letter.write_failed', ['error' => $exception::class]);
        }
    }
}
