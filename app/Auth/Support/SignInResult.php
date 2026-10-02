<?php

namespace App\Auth\Support;

use App\Models\User;
use Carbon\CarbonInterface;
use Laravel\Sanctum\PersonalAccessToken;
use SensitiveParameter;

/**
 * What a native sign-in step came to: a signed-in device (our own Sanctum token, shown once) or a pending second factor (the challenge to
 * answer). Failures are never a result: they are thrown as `ApiProblemException`s with their own code.
 */
final readonly class SignInResult
{
    private function __construct(
        public ?User $user,
        #[SensitiveParameter]
        public ?string $token,
        public ?PersonalAccessToken $accessToken,
        #[SensitiveParameter]
        public ?string $challenge,
        public ?CarbonInterface $challengeExpiresAt,
    ) {}

    public static function signedIn(User $user, #[SensitiveParameter] string $token, PersonalAccessToken $accessToken): self
    {
        return new self($user, $token, $accessToken, null, null);
    }

    public static function twoFactorRequired(#[SensitiveParameter] string $challenge, CarbonInterface $expiresAt): self
    {
        return new self(null, null, null, $challenge, $expiresAt);
    }

    public function isSignedIn(): bool
    {
        return $this->token !== null;
    }
}
