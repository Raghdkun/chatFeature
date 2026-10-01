<?php

namespace App\Domain\Widgets\Identity;

/**
 * Outcome of IdentityTokenVerifier::verify(): either a verified identity or a typed failure.
 */
final readonly class IdentityVerification
{
    private function __construct(
        public ?VerifiedIdentity $identity,
        public ?IdentityFailure $failure,
    ) {}

    public static function verified(VerifiedIdentity $identity): self
    {
        return new self($identity, null);
    }

    public static function failed(IdentityFailure $failure): self
    {
        return new self(null, $failure);
    }

    public function isValid(): bool
    {
        return $this->identity !== null;
    }
}
