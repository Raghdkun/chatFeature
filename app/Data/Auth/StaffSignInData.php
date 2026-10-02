<?php

namespace App\Data\Auth;

use App\Auth\Enums\AuthMode;
use App\Data\Chat\RealtimeEndpointData;
use Spatie\LaravelData\Data;

/**
 * The answer of a finished native sign-in (`POST /api/v1/auth/token`, `POST /api/v1/auth/token/two-factor`): the bearer token, shown once,
 * and what `GET /api/v1/auth/me` would say right after (the user, the active auth driver and its capabilities, the realtime address and the
 * server clock), so a client needs no second call to start.
 */
class StaffSignInData extends Data
{
    public function __construct(
        public string $token,
        public string $tokenType,
        public ?string $expiresAt,
        public AuthUserData $user,
        public AuthMode $mode,
        public AuthCapabilitiesData $capabilities,
        public ?RealtimeEndpointData $realtime,
        public string $serverTime,
    ) {}
}
