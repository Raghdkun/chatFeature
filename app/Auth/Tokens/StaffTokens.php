<?php

namespace App\Auth\Tokens;

use App\Auth\Pizzasys\ExternalSessionStore;
use App\Models\ExternalSession;
use App\Models\User;
use Carbon\CarbonInterface;
use Illuminate\Support\Collection;
use Laravel\Sanctum\PersonalAccessToken;

/**
 * A staff member's own API tokens (the bearer tokens a mobile app signs in with): list, find, revoke. Everything is scoped to the
 * user it is asked for, so another user's token is simply not found.
 *
 * Mode 2 (external auth portal): a token is bound to a portal session, and revoking it must also close that session and, upstream,
 * the portal token behind it (portal tokens never expire on their own), so revocation goes through the session store when a
 * session exists. Mode 1 tokens are plain Sanctum rows.
 */
final class StaffTokens
{
    /** What a staff token may do: there is no other kind of token, and no route asks for anything else. */
    public const ABILITIES = ['staff'];

    public function __construct(private readonly ExternalSessionStore $sessions) {}

    /**
     * The user's live tokens, newest first. Tokens past their expiry are listed too until they are pruned: they are dead already, and
     * the list shows their `expiresAt`.
     *
     * @return Collection<int, PersonalAccessToken>
     */
    public function for(User $user): Collection
    {
        /** @var Collection<int, PersonalAccessToken> $tokens */
        $tokens = $user->tokens()->orderByDesc('id')->get();

        return $tokens;
    }

    /** One of the user's own tokens, or `null`: someone else's token and an unknown id are indistinguishable. */
    public function find(User $user, int $id): ?PersonalAccessToken
    {
        /** @var PersonalAccessToken|null $token */
        $token = $user->tokens()->whereKey($id)->first();

        return $token;
    }

    /** The stored token a plain-text `id|secret` string belongs to (the sign-in answer's own token), or `null`. */
    public function fromPlainText(string $plainText): ?PersonalAccessToken
    {
        return PersonalAccessToken::findToken($plainText);
    }

    /**
     * Keeps a staff member's signed-in devices within `staff_auth.max_tokens_per_user` after a sign-in: tokens past their lifetime go
     * first (they are dead already), then the ones used least recently (`last_used_at`, else the issue time). The token that was just
     * issued is never touched. Revoking goes through {@see revoke()}, so in mode 2 the portal session of an evicted device ends too.
     *
     * @return int How many tokens were revoked.
     */
    public function enforceLimit(User $user, PersonalAccessToken $keep): int
    {
        $max = max(1, (int) config('staff_auth.max_tokens_per_user', 10));
        $revoked = 0;
        $live = [];

        foreach ($this->for($user) as $token) {
            if ($token->getKey() === $keep->getKey()) {
                continue;
            }

            $expires = $this->expiresAt($token);

            if ($expires !== null && $expires->isPast()) {
                $this->revoke($token);
                $revoked++;

                continue;
            }

            $live[] = $token;
        }

        // The new token takes one place: everything beyond `max - 1` others goes, the least recently used first.
        $excess = count($live) - ($max - 1);

        if ($excess <= 0) {
            return $revoked;
        }

        usort($live, static fn (PersonalAccessToken $a, PersonalAccessToken $b): int => [($a->last_used_at ?? $a->created_at)?->getTimestamp(), $a->getKey()] <=> [($b->last_used_at ?? $b->created_at)?->getTimestamp(), $b->getKey()]);

        foreach (array_slice($live, 0, $excess) as $token) {
            $this->revoke($token);
            $revoked++;
        }

        return $revoked;
    }

    /** Ends the token (and, in mode 2, the portal session bound to it, upstream included). */
    public function revoke(PersonalAccessToken $token): void
    {
        $session = ExternalSession::query()->with('environment')->where('sanctum_token_id', $token->getKey())->whereNull('revoked_at')->first();

        if ($session !== null) {
            // Deletes the Sanctum token as part of ending the session.
            $this->sessions->revoke($session, 'logout', upstreamLogout: true);
        }

        // Mode 1, or a mode-2 token whose session row is gone or already revoked.
        $token->newQuery()->whereKey($token->getKey())->delete();
    }

    /**
     * When the token stops working: the issue time plus `sanctum.expiration` (minutes; tokens do not slide), or the token's own
     * `expires_at` when that comes first.
     */
    public function expiresAt(PersonalAccessToken $token): ?CarbonInterface
    {
        $minutes = (int) config('sanctum.expiration');
        $byConfig = $minutes > 0 && $token->created_at !== null ? $token->created_at->copy()->addMinutes($minutes) : null;
        $own = $token->expires_at;

        if ($byConfig === null || $own === null) {
            return $byConfig ?? $own;
        }

        return $own->lessThan($byConfig) ? $own : $byConfig;
    }
}
