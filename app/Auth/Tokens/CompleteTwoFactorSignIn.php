<?php

namespace App\Auth\Tokens;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Support\SignInResult;
use App\Http\Exceptions\ApiProblemException;
use App\Models\StaffTwoFactorChallenge;
use App\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\RateLimiter;
use SensitiveParameter;

/**
 * Step two of a native staff sign-in (`POST /api/v1/auth/token/two-factor`): the second factor of an account whose password step was
 * answered with a challenge.
 *
 * The user is whoever the challenge was issued for: the request names nobody, so a challenge cannot be used for another account. The
 * challenge is used up atomically with the check (a replay, or two concurrent calls, get `invalid_challenge`), a recovery code is replaced
 * in the same transaction that uses the challenge up, and a wrong code counts against the challenge (burnt after a few), against the
 * account (a fresh challenge does not bring a fresh budget) and in the audit log. A locked account is refused before the code is looked at.
 */
final class CompleteTwoFactorSignIn
{
    private const OK = 'ok';

    private const WRONG = 'wrong';

    private const REPLAYED = 'replayed';

    public function __construct(
        private readonly AuthDriver $driver,
        private readonly TwoFactorChallenges $challenges,
        private readonly TwoFactorCodes $codes,
        private readonly StaffTokens $tokens,
        private readonly SignInAudit $audit,
    ) {}

    public function __invoke(#[SensitiveParameter] string $challenge, #[SensitiveParameter] ?string $code, #[SensitiveParameter] ?string $recoveryCode): SignInResult
    {
        $row = $this->challenges->find($challenge);

        if ($row === null) {
            $this->audit->twoFactorFailed(null, 'invalid_challenge');

            throw $this->invalidChallenge();
        }

        $user = $row->user;

        if (! $this->mayStillSignIn($user)) {
            $this->challenges->burn($row);
            $this->audit->twoFactorFailed($user, 'invalid_challenge');

            throw $this->invalidChallenge();
        }

        $this->refuseWhileLocked($user);

        $outcome = $recoveryCode !== null
            ? $this->withRecoveryCode($row, $user, $recoveryCode)
            : $this->withAuthenticatorCode($row, $user, (string) $code);

        if ($outcome === self::REPLAYED) {
            $this->audit->twoFactorFailed($user, 'invalid_challenge');

            throw $this->invalidChallenge();
        }

        if ($outcome === self::WRONG) {
            $this->countAgainst($user);
            $remaining = $this->challenges->recordWrongCode($row);
            $this->audit->twoFactorFailed($user, 'wrong_code', $remaining);

            throw new ApiProblemException(401, 'invalid_two_factor_code', $remaining > 0
                ? __('That code is not right. Check it and try again.')
                : __('That code is not right and this sign-in has used its attempts. Start again with your password.'), ['attempts_remaining' => $remaining]);
        }

        $this->forgiveFailures($user);

        $plain = $user->createToken($row->device_name, StaffTokens::ABILITIES);
        $accessToken = $plain->accessToken;
        $this->audit->issued($user, $accessToken, $this->driver->key(), $recoveryCode !== null ? 'recovery_code' : 'totp', $this->tokens->enforceLimit($user, $accessToken));

        return SignInResult::signedIn($user, $plain->plainTextToken, $accessToken);
    }

    /**
     * What the account still has to be at the second step. A challenge outlives a deactivation, a lost role, a switch of the auth mode or a
     * switched-off second factor by minutes at most, but it must not complete a sign-in the first step would no longer allow.
     */
    private function mayStillSignIn(?User $user): bool
    {
        return $user !== null
            && $user->is_active
            && $user->hasChatAccess()
            && $user->hasEnabledTwoFactorAuthentication()
            && $this->driver->key() === 'fortify';
    }

    private function withAuthenticatorCode(StaffTwoFactorChallenge $row, User $user, #[SensitiveParameter] string $code): string
    {
        if (! $this->codes->totpIsValid($user, $code)) {
            return self::WRONG;
        }

        return $this->challenges->consume($row) ? self::OK : self::REPLAYED;
    }

    /** The recovery code is matched on the locked user row and replaced together with using the challenge up: all or nothing. */
    private function withRecoveryCode(StaffTwoFactorChallenge $row, User $user, #[SensitiveParameter] string $submitted): string
    {
        return DB::transaction(function () use ($row, $user, $submitted): string {
            $locked = User::query()->whereKey($user->getKey())->lockForUpdate()->first();
            $match = $locked === null ? null : $this->codes->matchingRecoveryCode($locked, $submitted);

            if ($locked === null || $match === null) {
                return self::WRONG;
            }

            if (! $this->challenges->consume($row)) {
                return self::REPLAYED;
            }

            $locked->replaceRecoveryCode($match);

            return self::OK;
        });
    }

    private function refuseWhileLocked(User $user): void
    {
        foreach ($this->limits($user) as [$key, $max]) {
            if (RateLimiter::tooManyAttempts($key, $max)) {
                $this->audit->twoFactorFailed($user, 'locked');

                throw ApiProblemException::rateLimited(__('Too many wrong codes. Please try again later.'), RateLimiter::availableIn($key));
            }
        }
    }

    private function countAgainst(User $user): void
    {
        foreach ($this->limits($user) as [$key, , $decay]) {
            RateLimiter::hit($key, $decay);
        }
    }

    private function forgiveFailures(User $user): void
    {
        foreach ($this->limits($user) as [$key]) {
            RateLimiter::clear($key);
        }
    }

    /**
     * The per-account failure budgets: wrong codes a minute and an hour.
     *
     * @return list<array{0: string, 1: int, 2: int}> key, most failures, window in seconds
     */
    private function limits(User $user): array
    {
        return [
            ['staff-2fa-failed:minute:'.$user->getKey(), max(1, (int) config('staff_auth.two_factor.per_user_per_minute', 5)), 60],
            ['staff-2fa-failed:hour:'.$user->getKey(), max(1, (int) config('staff_auth.two_factor.per_user_per_hour', 20)), 3600],
        ];
    }

    private function invalidChallenge(): ApiProblemException
    {
        return ApiProblemException::unauthorized('invalid_challenge', __('This sign-in step has expired or was already used. Start again with your password.'));
    }
}
