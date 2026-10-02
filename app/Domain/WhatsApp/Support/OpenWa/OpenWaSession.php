<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

use App\Domain\WhatsApp\Enums\SessionStatus;
use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;
use App\Domain\WhatsApp\Support\PhoneNumber;
use Carbon\CarbonImmutable;
use Throwable;

/**
 * A session as OpenWA reports it (`SessionResponseDto`): `{id, name, status, phone, pushName, connectedAt, lastActive, createdAt,
 * updatedAt, lastError, restriction?, engineLoaded}`. `status` is our {@see SessionStatus} (null when OpenWA reports one we do not know:
 * keep the status you have), `rawStatus` the string as sent, `phone` is E.164 (`+...`) or null.
 */
final readonly class OpenWaSession
{
    public function __construct(
        public string $id,
        public string $name,
        public ?SessionStatus $status,
        public string $rawStatus,
        public ?string $phone,
        public ?string $pushName,
        public ?CarbonImmutable $connectedAt,
        public ?string $lastError,
        public bool $engineLoaded,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload
     *
     * @throws OpenWaUnavailable when there is no session id in it
     */
    public static function fromArray(array $payload): self
    {
        $id = $payload['id'] ?? null;

        if (! is_string($id) || $id === '') {
            throw new OpenWaUnavailable('OpenWA returned a session without an id.');
        }

        $raw = is_string($payload['status'] ?? null) ? $payload['status'] : '';

        return new self(
            id: $id,
            name: is_string($payload['name'] ?? null) ? $payload['name'] : '',
            status: SessionStatus::fromOpenWa($raw),
            rawStatus: $raw,
            phone: PhoneNumber::e164(is_string($payload['phone'] ?? null) ? $payload['phone'] : null),
            pushName: is_string($payload['pushName'] ?? null) && $payload['pushName'] !== '' ? mb_substr($payload['pushName'], 0, 120) : null,
            connectedAt: self::date($payload['connectedAt'] ?? null),
            lastError: is_string($payload['lastError'] ?? null) && $payload['lastError'] !== '' ? mb_substr($payload['lastError'], 0, 1000) : null,
            engineLoaded: ($payload['engineLoaded'] ?? false) === true,
        );
    }

    private static function date(mixed $value): ?CarbonImmutable
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        try {
            return CarbonImmutable::parse($value);
        } catch (Throwable) {
            return null;
        }
    }
}
