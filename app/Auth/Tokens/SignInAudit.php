<?php

namespace App\Auth\Tokens;

use App\Domain\Audit\AuditLogger;
use App\Models\User;
use Illuminate\Support\Facades\RateLimiter;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * The `audit_logs` rows of native sign-ins: a token issued (`auth.token.issued`), a password that was right for an account that still owes a
 * second factor (`auth.token.two_factor_required`), a refused sign-in (`auth.token.failed`) and a wrong second factor
 * (`auth.token.two_factor_failed`). They carry who, which mode, the device label and a reason; the request's address and user agent are added by
 * the logger. Never a password, a code, a challenge or a token (the logger also redacts keys that look like one).
 *
 * Failures are the rows an attacker can multiply, so they share a per-minute budget (`staff_auth.audit_failures_per_minute`): past it they are
 * not written, and ONE `auth.token.failure_flood` row a minute says that it is happening.
 */
final class SignInAudit
{
    private const FAILURE_BUDGET = 'staff-sign-in:audit-failures';

    private const FLOOD_MARKER = 'staff-sign-in:audit-flood';

    public function __construct(private readonly AuditLogger $audit) {}

    /**
     * @param  string|null  $secondFactor  `totp` or `recovery_code` when the sign-in went through the second-factor step
     */
    public function issued(User $user, PersonalAccessToken $token, string $mode, ?string $secondFactor, int $evictedTokens): void
    {
        // The subject is the token (its id, never its secret); the keys avoid the word "token" because the logger redacts such keys.
        $this->audit->record('auth.token.issued', $token, [
            'mode' => $mode,
            'device_name' => $token->name,
            'second_factor' => $secondFactor,
            'evicted_devices' => $evictedTokens,
        ], $user);
    }

    public function twoFactorRequired(User $user, string $mode, string $deviceName): void
    {
        $this->audit->record('auth.token.two_factor_required', $user, ['mode' => $mode, 'device_name' => $deviceName], $user);
    }

    /**
     * @param  string  $reason  `invalid_credentials`, `no_chat_access` or `unavailable` (the internal reason: the client always gets the documented answer)
     */
    public function failed(string $mode, string $reason, string $email, string $deviceName): void
    {
        if (! $this->failureRowAllowed()) {
            return;
        }

        $this->audit->record('auth.token.failed', null, ['mode' => $mode, 'reason' => $reason, 'email' => $email, 'device_name' => $deviceName]);
    }

    /**
     * @param  string  $reason  `wrong_code`, `invalid_challenge` (unknown, expired, used or burnt) or `locked`
     */
    public function twoFactorFailed(?User $user, string $reason, ?int $attemptsRemaining = null): void
    {
        if (! $this->failureRowAllowed()) {
            return;
        }

        $this->audit->record('auth.token.two_factor_failed', $user, ['reason' => $reason, 'attempts_remaining' => $attemptsRemaining], $user);
    }

    private function failureRowAllowed(): bool
    {
        $budget = max(1, (int) config('staff_auth.audit_failures_per_minute', 120));

        if (! RateLimiter::tooManyAttempts(self::FAILURE_BUDGET, $budget)) {
            RateLimiter::hit(self::FAILURE_BUDGET, 60);

            return true;
        }

        RateLimiter::attempt(self::FLOOD_MARKER, 1, fn () => $this->audit->record('auth.token.failure_flood', null, ['limit_per_minute' => $budget]), 60);

        return false;
    }
}
