<?php

namespace App\Auth\Tokens;

use App\Models\StaffTwoFactorChallenge;
use App\Models\User;
use Illuminate\Support\Str;
use SensitiveParameter;

/**
 * The challenge of a native sign-in that still owes its second factor. The password step answers with a random secret
 * (`tfc_` + 40 characters); only its sha256 is stored. A challenge belongs to one user and one device name, works once, lives
 * `staff_auth.two_factor.challenge_minutes` and burns after `challenge_attempts` wrong codes. It is not tied to an address: a phone
 * moves between networks between the two steps.
 *
 * Every state change is a guarded `UPDATE ... WHERE consumed_at IS NULL`, never read-then-write, so two concurrent calls with the same
 * secret cannot both win.
 */
final class TwoFactorChallenges
{
    public const PREFIX = 'tfc_';

    /** Length of the secret as the client sees it: the prefix plus 40 random characters. */
    public const LENGTH = 44;

    /**
     * @return array{0: string, 1: StaffTwoFactorChallenge} the secret (shown once) and the stored row
     */
    public function issue(User $user, string $deviceName, ?string $ip): array
    {
        // Old rows of this account are noise: keep the table small without waiting for the daily prune.
        StaffTwoFactorChallenge::query()->where('user_id', $user->getKey())->where('expires_at', '<', now())->delete();

        $secret = self::PREFIX.Str::random(self::LENGTH - strlen(self::PREFIX));

        $row = StaffTwoFactorChallenge::query()->create([
            'token_hash' => self::hash($secret),
            'user_id' => $user->getKey(),
            'device_name' => $deviceName,
            'attempts' => 0,
            'expires_at' => now()->addMinutes(max(1, (int) config('staff_auth.two_factor.challenge_minutes', 5))),
            'ip_address' => $ip,
        ]);

        return [$secret, $row];
    }

    /** The challenge a secret belongs to, only while it can still be answered: not used, not expired, not burnt. */
    public function find(#[SensitiveParameter] string $secret): ?StaffTwoFactorChallenge
    {
        return StaffTwoFactorChallenge::query()
            ->with('user')
            ->where('token_hash', self::hash($secret))
            ->whereNull('consumed_at')
            ->where('expires_at', '>', now())
            ->where('attempts', '<', $this->maxAttempts())
            ->first();
    }

    /**
     * A wrong code: counts against the challenge and burns it at the limit.
     *
     * @return int How many more wrong codes it takes (0: it is burnt, the client signs in again from the password).
     */
    public function recordWrongCode(StaffTwoFactorChallenge $challenge): int
    {
        $query = StaffTwoFactorChallenge::query()->whereKey($challenge->getKey());

        (clone $query)->whereNull('consumed_at')->where('attempts', '<', $this->maxAttempts())->increment('attempts');

        $attempts = (int) (clone $query)->value('attempts');

        if ($attempts >= $this->maxAttempts()) {
            $this->burn($challenge);
        }

        return max(0, $this->maxAttempts() - $attempts);
    }

    /** Uses the challenge up: `true` for exactly one caller, whatever the number of concurrent ones. */
    public function consume(StaffTwoFactorChallenge $challenge): bool
    {
        return StaffTwoFactorChallenge::query()
            ->whereKey($challenge->getKey())
            ->whereNull('consumed_at')
            ->where('expires_at', '>', now())
            ->where('attempts', '<', $this->maxAttempts())
            ->update(['consumed_at' => now()]) === 1;
    }

    public function burn(StaffTwoFactorChallenge $challenge): void
    {
        StaffTwoFactorChallenge::query()->whereKey($challenge->getKey())->whereNull('consumed_at')->update(['consumed_at' => now()]);
    }

    /** Deletes challenges that expired more than a day ago (the daily `chat:auth:prune-sessions`). */
    public function prune(): int
    {
        return StaffTwoFactorChallenge::query()->where('expires_at', '<', now()->subDay())->delete();
    }

    public static function hash(#[SensitiveParameter] string $secret): string
    {
        return hash('sha256', $secret);
    }

    private function maxAttempts(): int
    {
        return max(1, (int) config('staff_auth.two_factor.challenge_attempts', 5));
    }
}
