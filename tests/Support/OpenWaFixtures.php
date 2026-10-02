<?php

namespace Tests\Support;

use RuntimeException;

/**
 * What OpenWA really answers and delivers, from `tests/fixtures/openwa/*.json` (recorded from the real 0.23.7 image by the ops track, or
 * "documented" ones built from `docs/reference/openwa-api.md`; `index.json` lists them and says which is which). The tests of the client and
 * of the webhook are written against these files, so a fresh recording changes the suite's idea of OpenWA without touching a test.
 *
 * Three shapes:
 *  - REST fixtures: `{request: {method, path, body?}, response: {status, headers, body}}`: {@see self::status()}, {@see self::body()};
 *  - recorded deliveries: `{request: {headers, rawBody}, verification: {secret}}`: the exact signed bytes ({@see self::recordedDelivery()});
 *  - documented deliveries: `{delivery: {headers, payload}}`: a payload the test signs itself ({@see self::delivery()}).
 */
final class OpenWaFixtures
{
    /** A 1x1 PNG data URL: the recorded QR is scrubbed (`<REDACTED>`), this stands in for the image. */
    public const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    /**
     * The decoded fixture file.
     *
     * @return array<string, mixed>
     */
    public static function file(string $name): array
    {
        $path = base_path('tests/fixtures/openwa/'.$name.'.json');

        if (! is_file($path)) {
            throw new RuntimeException("No OpenWA fixture [{$name}] in tests/fixtures/openwa.");
        }

        $decoded = json_decode((string) file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);

        return is_array($decoded) ? $decoded : [];
    }

    /** The HTTP status OpenWA answered. */
    public static function status(string $name): int
    {
        return (int) (self::file($name)['response']['status'] ?? 0);
    }

    /**
     * The body OpenWA answered with; a scrubbed QR (`<REDACTED>`) is replaced by a real, tiny PNG data URL.
     *
     * @return array<array-key, mixed>
     */
    public static function body(string $name): array
    {
        $body = self::file($name)['response']['body'] ?? [];

        return is_array($body) ? self::unscrub($body) : [];
    }

    /**
     * The response headers OpenWA sent (lower case names).
     *
     * @return array<string, string>
     */
    public static function headers(string $name): array
    {
        return array_map(strval(...), (array) (self::file($name)['response']['headers'] ?? []));
    }

    /**
     * The request the recording sent (method, path, body).
     *
     * @return array<string, mixed>
     */
    public static function request(string $name): array
    {
        return (array) (self::file($name)['request'] ?? []);
    }

    /**
     * A documented delivery: its headers and payload, with the session id replaced when one is given.
     *
     * @return array{headers: array<string, string>, payload: array<string, mixed>}
     */
    public static function delivery(string $name, ?string $sessionId = null): array
    {
        $delivery = (array) (self::file($name)['delivery'] ?? []);
        $payload = (array) ($delivery['payload'] ?? []);

        if ($sessionId !== null) {
            $payload['sessionId'] = $sessionId;
        }

        return ['headers' => array_map(strval(...), (array) ($delivery['headers'] ?? [])), 'payload' => $payload];
    }

    /**
     * A recorded delivery exactly as it was signed: the raw body, its headers and the secret the webhook was registered with.
     *
     * @return array{rawBody: string, headers: array<string, string>, secret: string, sessionId: string}
     */
    public static function recordedDelivery(string $name): array
    {
        $file = self::file($name);
        $request = (array) ($file['request'] ?? []);
        $raw = (string) ($request['rawBody'] ?? '');
        $decoded = json_decode($raw, true);

        return [
            'rawBody' => $raw,
            'headers' => array_map(strval(...), (array) ($request['headers'] ?? [])),
            'secret' => (string) ($file['verification']['secret'] ?? ''),
            'sessionId' => is_array($decoded) ? (string) ($decoded['sessionId'] ?? '') : '',
        ];
    }

    /**
     * Every fixture name that starts with a prefix, sorted.
     *
     * @return list<string>
     */
    public static function names(string $prefix = ''): array
    {
        $names = [];

        foreach (glob(base_path('tests/fixtures/openwa/'.$prefix.'*.json')) ?: [] as $path) {
            $name = basename($path, '.json');

            if (! in_array($name, ['index', 'recording-meta'], true)) {
                $names[] = $name;
            }
        }

        sort($names);

        return $names;
    }

    /**
     * @param  array<array-key, mixed>  $value
     * @return array<array-key, mixed>
     */
    private static function unscrub(array $value): array
    {
        foreach ($value as $key => $item) {
            if (is_array($item)) {
                $value[$key] = self::unscrub($item);
            } elseif (is_string($item) && str_contains($item, '<REDACTED>') && str_starts_with($item, 'data:image/png;base64,')) {
                $value[$key] = self::PNG_DATA_URL;
            }
        }

        return $value;
    }
}
