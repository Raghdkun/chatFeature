<?php

namespace App\Auth\Support;

use App\Auth\Enums\AuthOutcome;
use App\Models\User;

/** Result of a web login attempt. `user` is set for Ok and NoChatAccess; it is never logged in by the driver. */
final readonly class AuthResult
{
    public function __construct(
        public AuthOutcome $outcome,
        public ?User $user = null,
        public ?string $message = null,
    ) {}

    public static function ok(User $user): self
    {
        return new self(AuthOutcome::Ok, $user);
    }

    public static function invalid(?string $message = null): self
    {
        return new self(AuthOutcome::Invalid, null, $message);
    }

    public static function unavailable(?string $message = null): self
    {
        return new self(AuthOutcome::Unavailable, null, $message);
    }

    public static function noChatAccess(?User $user = null, ?string $message = null): self
    {
        return new self(AuthOutcome::NoChatAccess, $user, $message);
    }

    public function isOk(): bool
    {
        return $this->outcome === AuthOutcome::Ok;
    }
}
