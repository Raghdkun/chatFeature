<?php

namespace App\Data\Auth;

use App\Auth\Support\AuthCapabilities;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Inertia `auth.capabilities`: what the UI may offer for the active auth driver. */
#[TypeScript]
class AuthCapabilitiesData extends Data
{
    public function __construct(
        public bool $canRegister,
        public bool $canResetPassword,
        public bool $canManage2fa,
        public bool $profileEditable,
        public ?string $portalUrl,
    ) {}

    public static function fromCapabilities(AuthCapabilities $capabilities): self
    {
        return new self(
            $capabilities->canRegister,
            $capabilities->canResetPassword,
            $capabilities->canManage2fa,
            $capabilities->profileEditable,
            $capabilities->portalUrl,
        );
    }
}
