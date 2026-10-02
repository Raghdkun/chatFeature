<?php

namespace App\Auth\Tokens;

use App\Models\User;
use Laravel\Fortify\Contracts\TwoFactorAuthenticationProvider;
use Laravel\Fortify\Fortify;
use SensitiveParameter;

/**
 * Checks a second factor with Fortify's own machinery, so the app and the dashboard accept exactly the same codes: the TOTP provider
 * (which also refuses a code it has already accepted in its window) and the stored recovery codes (replaced by a new one when used).
 * It only answers "is this code right"; spending a recovery code and using up the challenge happen together in the caller.
 */
final class TwoFactorCodes
{
    public function __construct(private readonly TwoFactorAuthenticationProvider $provider) {}

    /** A six (to eight) digit authenticator code, spaces allowed. Anything else is simply wrong. */
    public function totpIsValid(User $user, #[SensitiveParameter] string $code): bool
    {
        $digits = preg_replace('/\s+/', '', $code) ?? '';

        if (preg_match('/^\d{6,8}$/', $digits) !== 1 || $user->two_factor_secret === null) {
            return false;
        }

        return $this->provider->verify(Fortify::currentEncrypter()->decrypt($user->two_factor_secret), $digits);
    }

    /**
     * The stored recovery code the submitted one equals, or `null`. Every stored code is compared, none short-circuits, in constant time.
     */
    public function matchingRecoveryCode(User $user, #[SensitiveParameter] string $submitted): ?string
    {
        if ($user->two_factor_recovery_codes === null) {
            return null;
        }

        $match = null;

        foreach ((array) $user->recoveryCodes() as $stored) {
            if (is_string($stored) && hash_equals($stored, $submitted)) {
                $match = $stored;
            }
        }

        return $match;
    }
}
