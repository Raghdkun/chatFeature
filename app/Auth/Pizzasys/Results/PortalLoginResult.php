<?php

namespace App\Auth\Pizzasys\Results;

use SensitiveParameter;

/** Answer of `POST /auth/login`. `token` is the upstream user token: it stays on the server. */
final readonly class PortalLoginResult
{
    private function __construct(
        public PortalStatus $status,
        public ?string $token = null,
        public ?string $reason = null,
    ) {}

    public static function ok(#[SensitiveParameter] string $token): self
    {
        return new self(PortalStatus::Ok, $token);
    }

    public static function invalid(): self
    {
        return new self(PortalStatus::Invalid);
    }

    public static function unavailable(string $reason): self
    {
        return new self(PortalStatus::Unavailable, null, $reason);
    }

    public function isOk(): bool
    {
        return $this->status === PortalStatus::Ok && $this->token !== null;
    }

    /**
     * @return array<string, mixed>
     */
    public function __debugInfo(): array
    {
        return ['status' => $this->status, 'token' => $this->token === null ? null : '[redacted]', 'reason' => $this->reason];
    }
}
