<?php

namespace App\Auth\Tokens;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Support\SignInResult;
use App\Http\Exceptions\ApiProblemException;
use Illuminate\Http\Request;
use Laravel\Fortify\Fortify;
use Laravel\Fortify\LoginRateLimiter;
use RuntimeException;
use SensitiveParameter;

/**
 * Step one of a native staff sign-in (`POST /api/v1/auth/token`): the password, checked by the ACTIVE driver exactly as the dashboard's login
 * checks it, answered with a bearer token (no second factor) or a challenge (a second factor is owed).
 *
 * What it adds to the driver:
 *  - the dashboard's lockout: failed attempts are counted per email and address with Fortify's own {@see LoginRateLimiter}, so a wrong
 *    password costs the same budget here as on the web (the route's `login` limiter is the same one too). A locked key never reaches the driver;
 *  - one answer for every refusal: an unknown email, a wrong password, a deactivated account and (local accounts) an account without a chat
 *    role are all `401 invalid_credentials`, so the endpoint cannot be used to find out who has an account. In the external auth mode a person
 *    the portal itself signed in who has no chat role is told so (`403 no_chat_access`): the portal vouched for the password already;
 *  - `503 auth_unavailable` (never 401) when the portal cannot answer, with a fixed message that says nothing about why;
 *  - the device limit: a new token over `staff_auth.max_tokens_per_user` revokes the one used least recently.
 */
final class SignInWithPassword
{
    public function __construct(
        private readonly AuthDriver $driver,
        private readonly LoginRateLimiter $lockout,
        private readonly TwoFactorChallenges $challenges,
        private readonly StaffTokens $tokens,
        private readonly SignInAudit $audit,
    ) {}

    public function __invoke(Request $request, string $email, #[SensitiveParameter] string $password, string $deviceName): SignInResult
    {
        $mode = $this->driver->key();

        if ($this->lockout->tooManyAttempts($request)) {
            throw ApiProblemException::rateLimited(__('Too many sign-in attempts. Please try again later.'), $this->lockout->availableIn($request));
        }

        $result = $this->driver->attemptForApi([Fortify::username() => $email, 'password' => $password], $deviceName);

        switch ($result->outcome) {
            case AuthOutcome::Ok:
                $user = $result->user ?? throw new RuntimeException('A successful sign-in without a user.');
                $accessToken = $this->tokens->fromPlainText((string) $result->token) ?? throw new RuntimeException('A successful sign-in without a stored token.');

                $this->lockout->clear($request);
                $this->audit->issued($user, $accessToken, $mode, null, $this->tokens->enforceLimit($user, $accessToken));

                return SignInResult::signedIn($user, (string) $result->token, $accessToken);

            case AuthOutcome::TwoFactorRequired:
                $user = $result->user ?? throw new RuntimeException('A second factor is owed by nobody.');

                [$secret, $challenge] = $this->challenges->issue($user, $deviceName, $request->ip());
                $this->audit->twoFactorRequired($user, $mode, $deviceName);

                return SignInResult::twoFactorRequired($secret, $challenge->expires_at);

            case AuthOutcome::Unavailable:
                $this->audit->failed($mode, 'unavailable', $email, $deviceName);

                throw new ApiProblemException(503, 'auth_unavailable', __('The sign-in service is not reachable right now. Please try again in a few minutes.'), null, ['Retry-After' => '30']);
            case AuthOutcome::NoChatAccess:
                // The external portal checked the password, so telling this person what is missing gives nothing away. A local account's
                // answer would: it stays the one every refusal gets.
                if ($mode === 'pizzasys') {
                    $this->audit->failed($mode, 'no_chat_access', $email, $deviceName);

                    throw ApiProblemException::forbidden('no_chat_access', __('This account has no access to the chat dashboard. Ask an administrator to grant it.'));
                }

                return $this->refuse($request, $mode, 'no_chat_access', $email, $deviceName);

            default:
                return $this->refuse($request, $mode, 'invalid_credentials', $email, $deviceName);
        }
    }

    /** The one answer to every refusal, counted as a failed attempt. */
    private function refuse(Request $request, string $mode, string $reason, string $email, string $deviceName): never
    {
        $this->lockout->increment($request);
        $this->audit->failed($mode, $reason, $email, $deviceName);

        throw ApiProblemException::unauthorized('invalid_credentials', __('The email or password is incorrect.'));
    }
}
