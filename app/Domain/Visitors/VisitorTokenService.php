<?php

namespace App\Domain\Visitors;

use App\Models\Visitor;
use App\Models\VisitorSession;
use Carbon\CarbonInterface;
use Illuminate\Support\Str;

/**
 * Visitor bearer tokens: `vt_` + 40 random alphanumeric characters (about 238 bits). Only the sha256 of the token is
 * stored (`visitor_sessions.token_hash`), so a database leak does not yield usable tokens.
 *
 * `find()` hashes what the caller sent, looks the hash up by its unique index and then compares the stored hash with
 * `hash_equals` (MySQL collations compare case-insensitively; this makes the match exact and constant-time). Malformed
 * input is rejected before the database is touched. `resolve()` additionally requires the session to be usable.
 */
final class VisitorTokenService
{
    public const PREFIX = 'vt_';

    public const RANDOM_LENGTH = 40;

    /** `last_used_at` is refreshed at most this often: authenticated requests must not each write a row. */
    public const TOUCH_INTERVAL_SECONDS = 60;

    /**
     * Sessions made by `issue()` (and by the factories) are bound to the visitor and the visitor's widget.
     *
     * @param  array{page_url?: string|null, page_title?: string|null, referrer?: string|null, user_agent?: string|null, locale?: string|null}  $context
     */
    public function issue(Visitor $visitor, array $context = [], ?CarbonInterface $expiresAt = null): IssuedVisitorToken
    {
        $plaintext = self::generate();

        $session = new VisitorSession([
            'visitor_id' => $visitor->id,
            'widget_id' => $visitor->widget_id,
            'token_hash' => self::hash($plaintext),
            'expires_at' => $expiresAt ?? now()->addDays(max(1, settings()->int('chat.visitor_session_ttl_days', 30))),
            'page_url' => self::bounded($context['page_url'] ?? null, 2048),
            'page_title' => self::bounded($context['page_title'] ?? null, 255),
            'referrer' => self::bounded($context['referrer'] ?? null, 2048),
            'user_agent' => self::bounded($context['user_agent'] ?? null, 255),
            'locale' => self::bounded($context['locale'] ?? null, 12),
            'last_used_at' => now(),
        ]);
        $session->save();

        return new IssuedVisitorToken($plaintext, $session);
    }

    /**
     * The session a token belongs to, whatever its state (callers tell "unknown" from "revoked / expired" with it), or null
     * for anything that is not a token we issued.
     */
    public function find(string $plaintext): ?VisitorSession
    {
        if (! self::looksLikeToken($plaintext)) {
            return null;
        }

        $hash = self::hash($plaintext);
        $session = VisitorSession::query()->where('token_hash', $hash)->first();

        return $session !== null && hash_equals($session->token_hash, $hash) ? $session : null;
    }

    /** The session when the token is valid: known, not revoked, not expired. */
    public function resolve(string $plaintext): ?VisitorSession
    {
        $session = $this->find($plaintext);

        return $session !== null && $session->isActive() ? $session : null;
    }

    /**
     * Record that the session was just used (and the visitor was seen), at most once per `TOUCH_INTERVAL_SECONDS`.
     */
    public function touch(VisitorSession $session): void
    {
        $now = now();

        if ($session->last_used_at !== null && $session->last_used_at->diffInSeconds($now, true) < self::TOUCH_INTERVAL_SECONDS) {
            return;
        }

        $session->forceFill(['last_used_at' => $now])->saveQuietly();
        Visitor::query()->whereKey($session->visitor_id)->update(['last_seen_at' => $now]);
    }

    /** Ends the session for good (idempotent: a second call keeps the first revocation time). */
    public function revoke(VisitorSession $session): void
    {
        if ($session->revoked_at === null) {
            $session->forceFill(['revoked_at' => now()])->save();
        }
    }

    /** Ends every live session of the visitor; returns how many were revoked. */
    public function revokeAllFor(Visitor $visitor): int
    {
        return VisitorSession::query()
            ->where('visitor_id', $visitor->id)
            ->whereNull('revoked_at')
            ->update(['revoked_at' => now()]);
    }

    public static function generate(): string
    {
        return self::PREFIX.Str::random(self::RANDOM_LENGTH);
    }

    /** sha256 (lower-case hex, 64 characters) of a plaintext token. */
    public static function hash(string $plaintext): string
    {
        return hash('sha256', $plaintext);
    }

    public static function looksLikeToken(string $candidate): bool
    {
        return preg_match('/^'.self::PREFIX.'[A-Za-z0-9]{'.self::RANDOM_LENGTH.'}$/D', $candidate) === 1;
    }

    private static function bounded(?string $value, int $max): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return mb_substr($value, 0, $max);
    }
}
