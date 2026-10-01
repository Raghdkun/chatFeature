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
     * user.deleted / "deactivation": revoke all sessions and Sanctum tokens, set users.is_active = false
     * and identity.deactivated_at.
     */
    public function deactivateExternalId(string $externalId): void;

    /**
     * Role/permission/store changes: mark every identity stale and drop all verify caches.
     */
    public function flushAll(): void;
}
