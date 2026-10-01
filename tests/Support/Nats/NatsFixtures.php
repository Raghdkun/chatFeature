<?php

namespace Tests\Support\Nats;

use RuntimeException;

/**
 * The recorded pizzasys envelopes (tests/fixtures/nats/auth-events.json): 34 real events covering all 27 subjects.
 */
final class NatsFixtures
{
    /** @var list<array<string, mixed>>|null */
    private static ?array $events = null;

    /**
     * @return list<array<string, mixed>>
     */
    public static function all(): array
    {
        if (self::$events === null) {
            $decoded = json_decode((string) file_get_contents(dirname(__DIR__, 2).'/fixtures/nats/auth-events.json'), true, 512, JSON_THROW_ON_ERROR);
            self::$events = array_values($decoded['events']);
        }

        return self::$events;
    }

    /**
     * Every distinct `type` in the fixture file, e.g. `auth.v1.user.created`.
     *
     * @return list<string>
     */
    public static function types(): array
    {
        return array_values(array_unique(array_column(self::all(), 'type')));
    }

    /**
     * The first recorded envelope of this type (full type, or the short name without `auth.v1.`).
     *
     * @return array<string, mixed>
     */
    public static function envelope(string $type): array
    {
        $type = str_starts_with($type, 'auth.v1.') ? $type : 'auth.v1.'.$type;

        foreach (self::all() as $event) {
            if ($event['type'] === $type) {
                return $event;
            }
        }

        throw new RuntimeException("No fixture event of type {$type}.");
    }

    /**
     * @param  array<string, mixed>  $overrides  merged over the envelope (top level)
     */
    public static function json(string $type, array $overrides = []): string
    {
        return json_encode(array_replace(self::envelope($type), $overrides), JSON_THROW_ON_ERROR);
    }

    /**
     * A fresh ULID-shaped id (26 Crockford characters) so tests can publish "new" events.
     */
    public static function ulid(): string
    {
        $alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        $id = '';

        for ($i = 0; $i < 26; $i++) {
            $id .= $alphabet[random_int(0, 31)];
        }

        return $id;
    }
}
