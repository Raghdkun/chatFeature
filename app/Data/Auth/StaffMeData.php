<?php

namespace App\Data\Auth;

use App\Auth\Enums\AuthMode;
use Spatie\LaravelData\Data;

/**
 * The answer of `GET /api/v1/auth/me`: who the credential belongs to (the same `AuthUserData` the dashboard receives), which auth
 * driver is active and what it allows, the bearer token the call was made with (`null` for the dashboard's session cookie) and the
 * server clock, so a mobile client can correct its clock skew.
 */
class StaffMeData extends Data
{
    public function __construct(
        public AuthUserData $user,
        public AuthMode $mode,
        public AuthCapabilitiesData $capabilities,
        public ?ApiTokenData $token,
        public string $serverTime,
    ) {}
}
