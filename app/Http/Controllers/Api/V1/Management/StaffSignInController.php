<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthMode;
use App\Auth\Support\SignInResult;
use App\Auth\Tokens\CompleteTwoFactorSignIn;
use App\Auth\Tokens\SignInWithPassword;
use App\Auth\Tokens\StaffTokens;
use App\Data\Auth\AuthCapabilitiesData;
use App\Data\Auth\AuthUserData;
use App\Data\Auth\StaffSignInData;
use App\Data\Auth\StaffTwoFactorChallengeData;
use App\Data\Chat\RealtimeEndpointData;
use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Domain\Widgets\Support\Timestamps;
use App\Http\Requests\Auth\StaffSignInRequest;
use App\Http\Requests\Auth\StaffTwoFactorRequest;
use Illuminate\Http\JsonResponse;

/**
 * Signing in with a password from a native client: the one unauthenticated endpoint of the management API (docs/mobile-readiness.md,
 * docs/security.md). Stateless: no session, no cookie, no CORS. The work is in {@see SignInWithPassword} and {@see CompleteTwoFactorSignIn}.
 */
class StaffSignInController extends ManagementController
{
    public function __construct(
        private readonly AuthDriver $driver,
        private readonly AuthModeManager $modes,
        private readonly StaffTokens $tokens,
        private readonly ReverbEndpoint $realtime,
    ) {}

    public function store(StaffSignInRequest $request, SignInWithPassword $signIn): JsonResponse
    {
        /** @var array{email: string, password: string, device_name: string} $input */
        $input = $request->validated();

        return $this->answer($signIn($request, $input['email'], $input['password'], $input['device_name']));
    }

    public function twoFactor(StaffTwoFactorRequest $request, CompleteTwoFactorSignIn $complete): JsonResponse
    {
        /** @var array{challenge: string, code?: string|null, recovery_code?: string|null} $input */
        $input = $request->validated();

        return $this->answer($complete($input['challenge'], $input['code'] ?? null, $input['recovery_code'] ?? null));
    }

    private function answer(SignInResult $result): JsonResponse
    {
        if (! $result->isSignedIn() || $result->user === null || $result->accessToken === null) {
            return $this->data(new StaffTwoFactorChallengeData(
                twoFactor: true,
                challenge: (string) $result->challenge,
                expiresAt: (string) Timestamps::iso($result->challengeExpiresAt),
                methods: ['totp', 'recovery_code'],
            ), 202);
        }

        return $this->data(new StaffSignInData(
            token: (string) $result->token,
            tokenType: 'Bearer',
            expiresAt: Timestamps::iso($this->tokens->expiresAt($result->accessToken)),
            user: AuthUserData::fromUser($result->user),
            mode: AuthMode::tryFrom($this->modes->getDefaultDriver()) ?? AuthMode::Fortify,
            capabilities: AuthCapabilitiesData::fromCapabilities($this->driver->capabilities()),
            realtime: $this->realtime->isAvailable() ? RealtimeEndpointData::fromArray($this->realtime->forVisitors()) : null,
            serverTime: (string) Timestamps::iso(now()),
        ), 201);
    }
}
