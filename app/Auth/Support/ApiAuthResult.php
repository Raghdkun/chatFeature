<?php

namespace App\Auth\Support;

use App\Auth\Enums\AuthOutcome;
use App\Models\User;

/** Result of a mobile/API login. `token` is OUR Sanctum plain-text token, never an upstream one. */
final readonly class ApiAuthResult
{
    public function __construct(
        public AuthOutcome $outcome,
        public ?User $user = null,
        public ?string $token = null,
        public ?string $message = null,
    ) {}

    public static function ok(User $user, string $token): self
    {
        return new self(AuthOutcome::Ok, $user, $token);
    }

    public static function failed(AuthOutcome $outcome, ?string $message = null, ?User $user = null): self
    {
        return new self($outcome, $user, null, $message);
    }

    public function isOk(): bool
    {
        return $this->outcome === AuthOutcome::Ok;
    }
}
