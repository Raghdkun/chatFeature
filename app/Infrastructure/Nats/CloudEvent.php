<?php

namespace App\Infrastructure\Nats;

use JsonException;

/**
 * A parsed pizzasys CloudEvents envelope: {specversion, id (ULID), type, source, subject, time, data, meta}.
 *
 * `data` is deliberately private: some pizzasys events carry secrets (user.updated leaks a password hash), so
 * callers only get the few derived values they need and a dump/log of this object never shows the payload.
 */
final class CloudEvent
{
    public const SPEC_VERSION = '1.0';

    public const TYPE_PREFIX = 'auth.v1.';

    public const MAX_BYTES = 1_048_576;

    /**
     * Locations of the affected upstream user inside `data`, in priority order. `meta.actor_user_id` is the admin
     * who triggered the change, never the affected user, so it is intentionally not listed.
     *
     * @var list<string>
     */
    public const USER_ID_PATHS = ['user_id', 'user.id', 'assignment.user_id'];

    /**
     * @param  array<string, mixed>  $data
     */
    private function __construct(
        private readonly string $id,
        private readonly string $type,
        private readonly ?string $subject,
        private readonly array $data,
    ) {}

    /**
     * @throws InvalidCloudEvent
     */
    public static function fromJson(string $json): self
    {
        if (strlen($json) > self::MAX_BYTES) {
            throw new InvalidCloudEvent(InvalidCloudEvent::TOO_LARGE);
        }

        try {
            $decoded = json_decode($json, true, 64, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            throw new InvalidCloudEvent(InvalidCloudEvent::NOT_JSON);
        }

        if (! is_array($decoded) || $decoded === [] || array_is_list($decoded)) {
            throw new InvalidCloudEvent(InvalidCloudEvent::NOT_AN_OBJECT);
        }

        if (($decoded['specversion'] ?? null) !== self::SPEC_VERSION) {
            throw new InvalidCloudEvent(InvalidCloudEvent::UNSUPPORTED_SPECVERSION);
        }

        $id = self::nonEmptyString($decoded['id'] ?? null, 128);
        if ($id === null) {
            throw new InvalidCloudEvent(InvalidCloudEvent::MISSING_ID);
        }

        $type = self::nonEmptyString($decoded['type'] ?? null, 255);
        if ($type === null) {
            throw new InvalidCloudEvent(InvalidCloudEvent::MISSING_TYPE);
        }

        $data = $decoded['data'] ?? [];

        return new self(
            $id,
            $type,
            self::nonEmptyString($decoded['subject'] ?? null, 255),
            is_array($data) ? $data : [],
        );
    }

    public function id(): string
    {
        return $this->id;
    }

    /**
     * Idempotency key (fits `processed_events.event_id`, char(26)): the ULID itself, upper-cased; anything that is
     * not a ULID is folded into a deterministic 26-character key so a publisher change can never drop events.
     */
    public function dedupeKey(): string
    {
        if (preg_match('/^[0-9A-HJKMNP-TV-Z]{26}$/i', $this->id) === 1) {
            return strtoupper($this->id);
        }

        return 'X'.strtoupper(substr(hash('sha256', $this->id), 0, 25));
    }

    /** Full type, e.g. `auth.v1.user.deleted` (pizzasys publishes type == subject). */
    public function type(): string
    {
        return $this->type;
    }

    /** The envelope subject, falling back to the type. */
    public function subject(): string
    {
        return $this->subject ?? $this->type;
    }

    /** Whether the type belongs to the `auth.v1.` event family this app understands. */
    public function isAuthV1(): bool
    {
        return str_starts_with($this->type, self::TYPE_PREFIX);
    }

    /**
     * The type without the `auth.v1.` prefix (`user.deleted`); types outside `auth.v1.` are returned unchanged.
     */
    public function name(): string
    {
        return $this->isAuthV1() ? substr($this->type, strlen(self::TYPE_PREFIX)) : $this->type;
    }

    /**
     * The upstream user this event is about (pizzasys `sub`, as a string), or null when the event does not
     * identify one. Understands `data.user_id`, `data.user.id` and `data.assignment.user_id`.
     */
    public function externalUserId(): ?string
    {
        foreach (self::USER_ID_PATHS as $path) {
            $candidate = self::normaliseUserId($this->dataAt($path));

            if ($candidate !== null) {
                return $candidate;
            }
        }

        return null;
    }

    /**
     * Safe-to-log facts only.
     *
     * @return array{event_id: string, type: string}
     */
    public function logContext(): array
    {
        return ['event_id' => $this->id, 'type' => substr($this->type, 0, 128)];
    }

    /**
     * @return array{id: string, type: string}
     */
    public function __debugInfo(): array
    {
        return ['id' => $this->id, 'type' => $this->type];
    }

    private function dataAt(string $path): mixed
    {
        $value = $this->data;

        foreach (explode('.', $path) as $segment) {
            if (! is_array($value) || ! array_key_exists($segment, $value)) {
                return null;
            }

            $value = $value[$segment];
        }

        return $value;
    }

    private static function normaliseUserId(mixed $value): ?string
    {
        if (is_int($value)) {
            return $value >= 1 ? (string) $value : null;
        }

        if (is_string($value)) {
            $value = trim($value);

            return $value !== '' && strlen($value) <= 64 ? $value : null;
        }

        return null;
    }

    private static function nonEmptyString(mixed $value, int $maxLength): ?string
    {
        if (! is_string($value)) {
            return null;
        }

        $value = trim($value);

        return $value !== '' && strlen($value) <= $maxLength ? $value : null;
    }
}
