<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;

/**
 * The answer of the password step for an account with a second factor (`202`): no token yet, only the challenge to answer at
 * `POST /api/v1/auth/token/two-factor`.
 */
class StaffTwoFactorChallengeData extends Data
{
    /**
     * @param  list<string>  $methods
     */
    public function __construct(
        public bool $twoFactor,
        public string $challenge,
        public string $expiresAt,
        public array $methods,
    ) {}
}
