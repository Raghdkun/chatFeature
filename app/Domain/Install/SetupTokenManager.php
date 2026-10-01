<?php

namespace App\Domain\Install;

use Illuminate\Contracts\Session\Session;
use Illuminate\Http\Request;
use SensitiveParameter;

/**
 * One-time takeover guard for the wizard. `SETUP_TOKEN` comes from the environment (printed by
 * `chat:bootstrap-secrets`), is compared with hash_equals and is never written into a page, response, log or the
 * install state file. Verification is remembered per browser session, never globally.
 *
 * The token is skipped ONLY for APP_ENV=local AND a request that reaches this server straight from a loopback address
 * (127.0.0.1 / ::1, no proxy headers). A deployment that forgot to set APP_ENV=production (the example env file ships
 * `local`) therefore still asks for the token from everybody else, and answers "not configured" (fail closed) when it
 * has none.
 */
final class SetupTokenManager
{
    public const SESSION_KEY = 'setup.token_verified';

    /** Headers a reverse proxy adds: a request carrying any of them did not come straight from the loopback address. */
    private const PROXY_HEADERS = ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Forwarded-Port', 'Forwarded', 'X-Real-IP', 'CF-Connecting-IP', 'True-Client-IP'];

    public function isRequired(?Request $request = null): bool
    {
        return ! ($this->isLocalDevelopment() && $this->comesFromLoopback($request ?? request()));
    }

    /** A token is required but the server has none configured (fail closed). */
    public function isMisconfigured(?Request $request = null): bool
    {
        return $this->isRequired($request) && $this->expected() === '';
    }

    public function verify(#[SensitiveParameter] string $candidate): bool
    {
        $expected = $this->expected();

        if ($expected === '' || $candidate === '') {
            return false;
        }

        // Hash both sides so neither the comparison time nor an early exit depends on the length.
        return hash_equals(hash('sha256', $expected), hash('sha256', $candidate));
    }

    public function isVerified(Session $session, ?Request $request = null): bool
    {
        return ! $this->isRequired($request) || $session->get(self::SESSION_KEY) === true;
    }

    public function markVerified(Session $session): void
    {
        $session->put(self::SESSION_KEY, true);
    }

    private function isLocalDevelopment(): bool
    {
        return app()->environment('local');
    }

    /**
     * The TCP peer (not the "client IP" a trusted proxy header would report) is a loopback address, and nothing says a
     * proxy is in between.
     */
    private function comesFromLoopback(Request $request): bool
    {
        foreach (self::PROXY_HEADERS as $header) {
            if ($request->headers->has($header)) {
                return false;
            }
        }

        $peer = $request->server->get('REMOTE_ADDR');

        return is_string($peer) && ($peer === '::1' || $peer === '::ffff:127.0.0.1' || preg_match('/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $peer) === 1);
    }

    private function expected(): string
    {
        $token = config('install.setup_token');

        return is_string($token) ? trim($token) : '';
    }
}
