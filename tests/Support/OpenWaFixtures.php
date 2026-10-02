<?php

namespace Tests\Support;

/**
 * Answers of OpenWA as the tests use them. Every shape comes with a built-in default taken from `docs/reference/openwa-api.md`; when
 * a recorded answer of the real image exists as `tests/fixtures/openwa/<name>.json` (the ops track records them), that file is used
 * instead, so the suite can be pointed at real shapes without touching a test.
 *
 * Names in use: `session-created`, `session-initializing`, `session-qr-ready`, `session-ready`, `session-disconnected`, `qr`,
 * `webhook-created`, `send-text`, `ping`.
 */
final class OpenWaFixtures
{
    /** A 1x1 PNG, base64: the smallest valid QR stand-in. */
    public const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    /**
     * A session as `SessionResponseDto` shapes it, in the given wire status.
     *
     * @return array<string, mixed>
     */
    public static function session(string $status = 'ready'): array
    {
        return self::load('session-'.str_replace('_', '-', $status), [
            'id' => '8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a',
            'name' => 'support-main',
            'status' => $status,
            'phone' => $status === 'ready' ? '6281234567890' : null,
            'pushName' => $status === 'ready' ? 'Support' : null,
            'connectedAt' => $status === 'ready' ? '2026-06-25T08:14:02.000Z' : null,
            'lastActive' => null,
            'createdAt' => '2026-06-20T11:30:00.000Z',
            'updatedAt' => '2026-06-25T09:01:55.000Z',
            'lastError' => null,
            'engineLoaded' => $status !== 'created',
        ]);
    }

    /**
     * @param  array<string, mixed>  $default
     * @return array<string, mixed>
     */
    public static function load(string $name, array $default): array
    {
        $path = base_path('tests/fixtures/openwa/'.$name.'.json');

        if (is_file($path)) {
            $decoded = json_decode((string) file_get_contents($path), true);

            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return $default;
    }
}
