<?php

namespace Tests\Support;

use App\Models\User;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Hash;
use Illuminate\Testing\TestResponse;
use Laravel\Fortify\Contracts\TwoFactorAuthenticationProvider;
use Laravel\Fortify\RecoveryCode;
use PragmaRX\Google2FA\Google2FA;

/**
 * Helpers of the native sign-in tests (`POST /api/v1/auth/token`): the two calls, an account with a real second factor, authenticator codes
 * for chosen time steps, and the hash-counting hasher.
 */
trait InteractsWithStaffSignIn
{
    protected function signIn(string $email, string $password = 'password', string $device = 'Pixel 9'): TestResponse
    {
        return $this->postJson('/api/v1/auth/token', ['email' => $email, 'password' => $password, 'device_name' => $device]);
    }

    protected function answerChallenge(string $challenge, ?string $code = null, ?string $recoveryCode = null): TestResponse
    {
        return $this->postJson('/api/v1/auth/token/two-factor', array_filter(['challenge' => $challenge, 'code' => $code, 'recovery_code' => $recoveryCode], static fn ($value): bool => $value !== null));
    }

    /**
     * Gives the user a real, confirmed second factor.
     *
     * @return array{secret: string, recovery: list<string>}
     */
    protected function enrollTwoFactor(User $user): array
    {
        $secret = app(TwoFactorAuthenticationProvider::class)->generateSecretKey();
        $recovery = Collection::times(8, static fn (): string => RecoveryCode::generate())->all();

        $user->forceFill([
            'two_factor_secret' => encrypt($secret),
            'two_factor_recovery_codes' => encrypt(json_encode($recovery)),
            'two_factor_confirmed_at' => now(),
        ])->save();

        return ['secret' => $secret, 'recovery' => $recovery];
    }

    /** The authenticator code of the current time step (`$step` -1 / +1: the neighbours the provider also accepts; each is used at most once). */
    protected function totp(string $secret, int $step = 0): string
    {
        $engine = app(Google2FA::class);

        return $engine->oathTotp($secret, $engine->getTimestamp() + $step);
    }

    /** A six-digit code that is not valid for the secret now (or in the neighbouring steps the provider accepts). */
    protected function wrongTotp(string $secret): string
    {
        $valid = [$this->totp($secret, -1), $this->totp($secret), $this->totp($secret, 1)];

        for ($candidate = 111111; ; $candidate += 7) {
            $code = (string) $candidate;

            if (! in_array($code, $valid, true)) {
                return $code;
            }
        }
    }

    protected function countHashChecks(): CountingHasher
    {
        $hasher = new CountingHasher(app('hash'));
        Hash::swap($hasher);
        // The user provider takes the hasher when a guard is built: build them again.
        $this->app['auth']->forgetGuards();

        return $hasher;
    }
}
