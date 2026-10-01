<?php

namespace Tests\Support\Nats;

use Illuminate\Support\Facades\Log;

/**
 * Stand-in for the Log facade root: remembers every call so tests can assert on what was (not) logged.
 */
final class LogRecorder
{
    /** @var list<array{level: string, message: string, context: array<string, mixed>}> */
    public array $records = [];

    /**
     * @param  array<int, mixed>  $arguments
     */
    public function __call(string $method, array $arguments): mixed
    {
        $message = $arguments[0] ?? '';
        $context = $arguments[1] ?? [];

        $this->records[] = [
            'level' => $method,
            'message' => is_string($message) ? $message : get_debug_type($message),
            'context' => is_array($context) ? $context : [],
        ];

        return null;
    }

    public static function install(): self
    {
        $recorder = new self;
        Log::swap($recorder);

        return $recorder;
    }

    /** Everything logged so far as one searchable string. */
    public function dump(): string
    {
        return json_encode($this->records, JSON_THROW_ON_ERROR);
    }

    /**
     * @return list<array{level: string, message: string, context: array<string, mixed>}>
     */
    public function messages(string $message): array
    {
        return array_values(array_filter($this->records, static fn (array $record): bool => $record['message'] === $message));
    }
}
