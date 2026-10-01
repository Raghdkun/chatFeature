<?php

namespace App\Auth\Pizzasys\Actions;

/** Outcome of {@see ActivateEnvironment}. `code` is machine readable; `message` is safe to show. */
final readonly class ActivationResult
{
    private function __construct(
        public bool $ok,
        public ?string $code,
        public ?string $message,
    ) {}

    public static function activated(): self
    {
        return new self(true, null, null);
    }

    public static function failed(string $code, string $message): self
    {
        return new self(false, $code, $message);
    }
}
