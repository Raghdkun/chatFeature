<?php

namespace App\Auth\Support;

/** What the UI may offer for the active auth driver (hide whatever the driver cannot honour). */
final readonly class AuthCapabilities
{
    public function __construct(
        public bool $canRegister,
        public bool $canResetPassword,
        public bool $canManage2fa,
        public bool $profileEditable,
        public ?string $portalUrl,
    ) {}
}
