<?php

namespace App\Domain\WhatsApp\Support\OpenWa;

use App\Domain\WhatsApp\Support\OpenWa\Exceptions\OpenWaUnavailable;

/** The answer of `POST /api/auth/validate`: the API key is valid, its `role` (`viewer | operator | admin`) and the engine OpenWA runs. */
final readonly class OpenWaPing
{
    public function __construct(
        public string $role,
        public string $engine,
    ) {}

    /**
     * @param  array<array-key, mixed>  $payload
     *
     * @throws OpenWaUnavailable when the body does not say the key is valid
     */
    public static function fromArray(array $payload): self
    {
        if (($payload['valid'] ?? null) !== true) {
            throw new OpenWaUnavailable('OpenWA did not confirm the API key.');
        }

        return new self(
            role: is_string($payload['role'] ?? null) ? strtolower($payload['role']) : 'unknown',
            engine: is_string($payload['engineType'] ?? null) ? $payload['engineType'] : 'unknown',
        );
    }

    /** The key may start sessions and send messages (`operator` or `admin`). */
    public function canOperate(): bool
    {
        return in_array($this->role, ['operator', 'admin'], true);
    }
}
