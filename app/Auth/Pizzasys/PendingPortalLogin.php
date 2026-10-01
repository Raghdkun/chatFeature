<?php

namespace App\Auth\Pizzasys;

use App\Models\User;
use App\Models\UserExternalIdentity;
use SensitiveParameter;

/**
 * A portal login the driver has accepted but whose session has not been opened yet (the Fortify pipeline logs the
 * user in afterwards). Holds the upstream user token in memory only.
 */
final readonly class PendingPortalLogin
{
    public function __construct(
        public User $user,
        public UserExternalIdentity $identity,
        #[SensitiveParameter]
        public string $token,
    ) {}

    /**
     * @return array<string, mixed>
     */
    public function __debugInfo(): array
    {
        return ['user' => $this->user->getKey(), 'identity' => $this->identity->getKey(), 'token' => '[redacted]'];
    }
}
