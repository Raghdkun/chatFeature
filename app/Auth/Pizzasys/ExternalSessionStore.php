<?php

namespace App\Auth\Pizzasys;

use App\Auth\Support\SessionContext;
use App\Models\ExternalSession;
use App\Models\User;
use App\Models\UserExternalIdentity;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Session\SessionManager;
use Illuminate\Support\Str;
use Laravel\Sanctum\PersonalAccessToken;
use Throwable;

/**
 * Lifecycle of `external_sessions`: opening one when a portal login succeeds, finding the one bound to a request and
 * revoking them. Revoking ends everything that hangs off the session: our Sanctum token, the browser session record
 * (best effort), the cached verify answer, the stored upstream token (wiped) and, when asked, that token upstream.
 */
final class ExternalSessionStore
{
    public function __construct(
        private readonly PortalGateway $gateway,
        private readonly SessionManager $sessions,
    ) {}

    public function open(PendingPortalLogin $login, ?Request $request = null, ?int $sanctumTokenId = null, ?string $laravelSessionId = null): ExternalSession
    {
        /** @var ExternalSession $session */
        $session = ExternalSession::query()->create([
            'user_id' => $login->user->getKey(),
            'identity_id' => $login->identity->getKey(),
            'auth_environment_id' => $login->identity->auth_environment_id,
            'laravel_session_id' => $laravelSessionId,
            'sanctum_token_id' => $sanctumTokenId,
            'token' => $login->token,
            'last_verified_at' => now(),
            'verify_fail_count' => 0,
            'ip' => $request?->ip(),
            'user_agent' => $request?->userAgent() !== null ? Str::limit($request->userAgent(), 500, '') : null,
        ]);

        return $session;
    }

    /** The portal session bound to this request (browser session or bearer token) of this user, if any. */
    public function find(SessionContext $context, User $user): ?ExternalSession
    {
        $query = ExternalSession::query()->with(['identity', 'environment'])->where('user_id', $user->getKey());

        if ($context->sanctumTokenId !== null) {
            return $query->where('sanctum_token_id', $context->sanctumTokenId)->first();
        }

        if ($context->externalSessionId !== null) {
            return $query->whereKey($context->externalSessionId)->first();
        }

        return null;
    }

    /**
     * @param  bool  $upstreamLogout  Also call the portal's logout for THIS token (user-initiated sign-out only).
     */
    public function revoke(ExternalSession $session, string $reason, bool $upstreamLogout = false): void
    {
        if ($session->isRevoked()) {
            return;
        }

        $token = $session->token;
        $endpoint = $session->environment->endpoint();

        $session->forceFill(['revoked_at' => now(), 'revoked_reason' => $reason, 'token_encrypted' => null])->save();

        if ($session->sanctum_token_id !== null) {
            PersonalAccessToken::query()->whereKey($session->sanctum_token_id)->delete();
        }

        $this->destroyBrowserSession($session->laravel_session_id);

        if ($token !== null && $endpoint !== null) {
            $upstreamLogout ? $this->gateway->logout($endpoint, $token) : $this->gateway->forget($endpoint->key, $token);
        }
    }

    /** Revoke every live session of a user. @return int How many were revoked. */
    public function revokeAllForUser(User $user, string $reason): int
    {
        return $this->revokeWhere(ExternalSession::query()->where('user_id', $user->getKey()), $reason);
    }

    /** Revoke every live session of one portal identity (its account was deleted upstream). @return int How many were revoked. */
    public function revokeForIdentity(UserExternalIdentity $identity, string $reason): int
    {
        return $this->revokeWhere(ExternalSession::query()->where('identity_id', $identity->getKey()), $reason);
    }

    /** Revoke every live session that does NOT belong to the given environment (environment switch). */
    public function revokeOutsideEnvironment(int $environmentId, string $reason): int
    {
        return $this->revokeWhere(ExternalSession::query()->where('auth_environment_id', '!=', $environmentId), $reason);
    }

    /**
     * @param  Builder<ExternalSession>  $query
     */
    private function revokeWhere(Builder $query, string $reason): int
    {
        $sessions = $query->whereNull('revoked_at')->with('environment')->get();

        foreach ($sessions as $session) {
            $this->revoke($session, $reason);
        }

        return $sessions->count();
    }

    private function destroyBrowserSession(?string $id): void
    {
        if ($id === null || $id === '') {
            return;
        }

        try {
            $this->sessions->driver()->getHandler()->destroy($id);
        } catch (Throwable) {
            // Best effort: the session is rejected on its next request anyway because the portal session is revoked.
        }
    }
}
