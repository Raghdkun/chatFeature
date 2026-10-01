<?php

namespace App\Auth\Pizzasys\Results;

/** Answer of `token-verify` (or of the `/auth/me` fallback). */
final readonly class PortalVerifyResult
{
    private function __construct(
        public PortalStatus $status,
        public ?PortalClaims $claims = null,
        public ?string $reason = null,
        public ?string $message = null,
        public bool $fromCache = false,
        public bool $viaUserToken = false,
    ) {}

    public static function active(PortalClaims $claims): self
    {
        return new self(PortalStatus::Ok, $claims);
    }

    public static function inactive(): self
    {
        return new self(PortalStatus::Inactive);
    }

    public static function serviceRejected(?string $message = null): self
    {
        return new self(PortalStatus::ServiceRejected, null, 'service_rejected', $message);
    }

    public static function unavailable(string $reason): self
    {
        return new self(PortalStatus::Unavailable, null, $reason);
    }

    public function isActive(): bool
    {
        return $this->status === PortalStatus::Ok && $this->claims !== null;
    }

    /** The same answer, marked as served from the verify cache. */
    public function cached(): self
    {
        return new self($this->status, $this->claims, $this->reason, $this->message, true, $this->viaUserToken);
    }

    /** The same answer, marked as obtained with the user's own token (service credential rejected). */
    public function viaUserToken(): self
    {
        return new self($this->status, $this->claims, $this->reason, $this->message, $this->fromCache, true);
    }
}
