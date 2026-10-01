<?php

namespace App\Auth\Pizzasys;

/**
 * Request-scoped hand-over between `PizzasysDriver::attempt()` (which never logs anyone in) and the `Login` event
 * listener that opens the portal session once the guard has logged the user in. Registered as a scoped singleton so
 * nothing outlives the request.
 */
final class PendingPortalLogins
{
    /** @var array<int|string, PendingPortalLogin> */
    private array $pending = [];

    public function put(PendingPortalLogin $login): void
    {
        $this->pending[$login->user->getKey()] = $login;
    }

    public function pull(int|string $userId): ?PendingPortalLogin
    {
        $login = $this->pending[$userId] ?? null;
        unset($this->pending[$userId]);

        return $login;
    }
}
