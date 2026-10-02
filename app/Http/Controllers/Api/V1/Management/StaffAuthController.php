<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Auth\AuthModeManager;
use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthMode;
use App\Auth\Tokens\StaffTokens;
use App\Data\Auth\ApiTokenData;
use App\Data\Auth\AuthCapabilitiesData;
use App\Data\Auth\AuthUserData;
use App\Data\Auth\StaffMeData;
use App\Data\Chat\RealtimeEndpointData;
use App\Domain\Chat\Realtime\ReverbEndpoint;
use App\Domain\Widgets\Support\Timestamps;
use App\Http\Exceptions\ApiProblemException;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * What a signed-in client needs to know about its own credential (`GET /auth/me`) and to manage it: its own tokens
 * (`GET /auth/tokens`, `DELETE /auth/tokens/{id}`) and signing out of the bearer token it is using (`POST /auth/logout`).
 *
 * Everything is scoped to the caller: there is no user id in these URLs, another user's token is `404`, and a token string is never
 * returned (only its hash is stored). Signing IN with a password is not an endpoint of this controller: see docs/mobile-readiness.md.
 */
class StaffAuthController extends ChatStaffController
{
    public function me(Request $request, AuthDriver $driver, AuthModeManager $modes, StaffTokens $tokens, ReverbEndpoint $realtime): JsonResponse
    {
        $user = $this->staff($request);
        $current = $this->currentToken($request);

        return $this->data(new StaffMeData(
            user: AuthUserData::fromUser($user),
            mode: AuthMode::tryFrom($modes->getDefaultDriver()) ?? AuthMode::Fortify,
            capabilities: AuthCapabilitiesData::fromCapabilities($driver->capabilities()),
            token: $current === null ? null : ApiTokenData::fromModel($current, (int) $current->getKey(), $tokens),
            realtime: $realtime->isAvailable() ? RealtimeEndpointData::fromArray($realtime->forVisitors()) : null,
            serverTime: (string) Timestamps::iso(now()),
        ));
    }

    public function tokens(Request $request, StaffTokens $tokens): JsonResponse
    {
        $user = $this->staff($request);
        $currentId = $this->currentToken($request)?->getKey();

        return $this->list($tokens->for($user)->map(
            fn (PersonalAccessToken $token): ApiTokenData => ApiTokenData::fromModel($token, $currentId === null ? null : (int) $currentId, $tokens),
        ));
    }

    public function revoke(Request $request, int $token, StaffTokens $tokens): Response
    {
        $row = $tokens->find($this->staff($request), $token);

        if ($row === null) {
            throw ApiProblemException::notFound('token_not_found', __('This token does not exist.'));
        }

        $tokens->revoke($row);

        return response()->noContent();
    }

    /** Ends the bearer token this call was made with, and nothing else (the user's other devices keep theirs). */
    public function logout(Request $request, StaffTokens $tokens): Response
    {
        $this->staff($request);
        $current = $this->currentToken($request);

        if ($current === null) {
            throw ApiProblemException::conflict('not_a_token_session', __('This call signs out a bearer token. Sign out of the dashboard with POST /logout instead.'));
        }

        $tokens->revoke($current);

        return response()->noContent();
    }

    /** The personal access token of the request, `null` when the dashboard's session cookie authenticated it (a transient token). */
    private function currentToken(Request $request): ?PersonalAccessToken
    {
        $user = $request->user();
        $token = $user instanceof User ? $user->currentAccessToken() : null;

        return $token instanceof PersonalAccessToken ? $token : null;
    }
}
