<?php

namespace App\Domain\Install;

use Illuminate\Contracts\Session\Session;

/**
 * One-time takeover guard for the wizard. `SETUP_TOKEN` comes from the environment (printed by
 * `chat:bootstrap-secrets`), is compared with hash_equals, skipped when APP_ENV=local and is never
 * written into a page, response, log or the install state file. Verification is remembered per
 * browser session, never globally.
 */
final class SetupTokenManager
{
    public const SESSION_KEY = 'setup.token_verified';

    public function isRequired(): bool
    {
        return ! app()->environment('local');
    }

    /** A token is required but the server has none configured (fail closed). */
    public function isMisconfigured(): bool
    {
        return $this->isRequired() && $this->expected() === '';
    }

    public function verify(string $candidate): bool
    {
        $expected = $this->expected();

        if ($expected === '' || $candidate === '') {
            return false;
        }

        // Hash both sides so neither the comparison time nor an early exit depends on the length.
        return hash_equals(hash('sha256', $expected), hash('sha256', $candidate));
    }

    public function isVerified(Session $session): bool
    {
        return ! $this->isRequired() || $session->get(self::SESSION_KEY) === true;
    }

    public function markVerified(Session $session): void
    {
        $session->put(self::SESSION_KEY, true);
    }

    private function expected(): string
    {
        $token = config('install.setup_token');

        return is_string($token) ? trim($token) : '';
    }
}
