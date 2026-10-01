<?php

namespace App\Auth\Pizzasys\Contracts;

/**
 * Invalidates cached/derived pizzasys identity state. Implemented by the PizzasysDriver side (track 2A),
 * consumed by the NATS event handlers (track 2B). Contract: docs/contracts/auth-pizzasys.md.
 */
interface IdentityInvalidator
{
    /**
     * Drop cached verify results for this upstream user and mark the identity stale
     * (it is re-verified on its next request).
     */
    public function flushForExternalId(string $externalId): void;

    /**
     * user.deleted / "deactivation": set identity.deactivated_at on that portal account and revoke ITS sessions and
     * Sanctum tokens. The local user (`users.is_active`) is left alone, so a wrong event cannot lock a person out for
     * good; `chat:auth:reactivate` reverses a deactivation.
     */
    public function deactivateExternalId(string $externalId): void;

    /**
     * Role/permission/store changes: mark every identity stale and drop all verify caches.
     */
    public function flushAll(): void;
}
