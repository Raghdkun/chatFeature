<?php

namespace App\Auth\Drivers;

use App\Auth\Contracts\AuthDriver;
use App\Auth\Enums\AuthOutcome;
use App\Auth\Enums\SessionVerdict;
use App\Auth\Pizzasys\AuthEnvironmentRepository;
use App\Auth\Pizzasys\ExternalSessionStore;
use App\Auth\Pizzasys\PendingPortalLogin;
use App\Auth\Pizzasys\PendingPortalLogins;
use App\Auth\Pizzasys\PizzasysCircuitBreaker;
use App\Auth\Pizzasys\PizzasysEndpoint;
use App\Auth\Pizzasys\PortalGateway;
use App\Auth\Pizzasys\PortalHealth;
use App\Auth\Pizzasys\PortalLabel;
use App\Auth\Pizzasys\Results\PortalFailure;
use App\Auth\Pizzasys\Results\PortalStatus;
use App\Auth\Pizzasys\Results\PortalVerifyResult;
use App\Auth\Roles\PizzasysRoleResolver;
use App\Auth\Shadow\ShadowSyncResult;
use App\Auth\Shadow\ShadowUserSync;
use App\Auth\Support\ApiAuthResult;
use App\Auth\Support\AuthCapabilities;
use App\Auth\Support\AuthResult;
use App\Auth\Support\HealthReport;
use App\Auth\Support\SessionContext;
use App\Auth\Tokens\StaffTokens;
use App\Domain\Settings\SettingsRepository;
use App\Models\ExternalSession;
use App\Models\User;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Auth\Factory as AuthFactory;
use Illuminate\Contracts\Auth\StatefulGuard;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Laravel\Fortify\Fortify;
use SensitiveParameter;

/**
 * Mode 2: staff sign in with their account in the external pizzasys auth portal.
 *
 * Login is server side (browser -> this app -> portal), so the upstream token never reaches a client. The flow is
 * login -> immediate `token-verify` (canonical roles/permissions) -> {@see ShadowUserSync} ->
 * {@see PizzasysRoleResolver} -> "no chat access" when the person is neither admin nor agent.
 *
 * `attempt()` returns the user and never logs in (Fortify does, after the attempt), so the portal session is opened
 * by the `Login` event listener from the hand-over in {@see PendingPortalLogins}. The verdict is memoised on the
 * request. Sessions are re-verified against the portal (cached) and survive short portal outages (grace window);
 * `refresh-token` is never called.
 */
final class PizzasysDriver implements AuthDriver
{
    /** Request attribute shared with the Fortify authenticate callback (memoised web verdict). */
    public const ATTEMPT_ATTRIBUTE = 'auth.attempt';

    public function __construct(
        private readonly AuthEnvironmentRepository $environments,
        private readonly PortalGateway $gateway,
        private readonly PortalHealth $health,
        private readonly PizzasysCircuitBreaker $breaker,
        private readonly ShadowUserSync $shadow,
        private readonly PizzasysRoleResolver $roles,
        private readonly ExternalSessionStore $sessions,
        private readonly SettingsRepository $settings,
        private readonly AuthFactory $auth,
    ) {}

    public function key(): string
    {
        return 'pizzasys';
    }

    /** Registration, password reset, 2FA and the profile are all managed by the portal. */
    public function capabilities(): AuthCapabilities
    {
        return new AuthCapabilities(
            canRegister: false,
            canResetPassword: false,
            canManage2fa: false,
            profileEditable: false,
            // Shared with anonymous visitors on every page: only a public label, never the portal's real API address.
            portalUrl: PortalLabel::forBaseUrl($this->environments->active()?->base_url),
        );
    }

    public function attempt(Request $request): AuthResult
    {
        $memo = $request->attributes->get(self::ATTEMPT_ATTRIBUTE);

        if ($memo instanceof AuthResult) {
            return $memo;
        }

        $email = $request->input(Fortify::username());
        $password = $request->input('password');

        $result = is_string($email) && is_string($password) && trim($email) !== '' && $password !== ''
            ? $this->authenticate(trim($email), $password)[0]
            : AuthResult::invalid();

        $request->attributes->set(self::ATTEMPT_ATTRIBUTE, $result);

        return $result;
    }

    public function attemptForApi(#[SensitiveParameter] array $credentials, string $deviceName): ApiAuthResult
    {
        $email = $credentials[Fortify::username()] ?? null;
        $password = $credentials['password'] ?? null;

        if (! is_string($email) || ! is_string($password) || trim($email) === '' || $password === '') {
            return ApiAuthResult::failed(AuthOutcome::Invalid);
        }

        [$result, $pending] = $this->authenticate(trim($email), $password);

        if (! $result->isOk() || $pending === null) {
            return ApiAuthResult::failed($result->outcome, $result->message, $result->user);
        }

        // Our own Sanctum token, bound to the portal session; the upstream token never leaves the server.
        return DB::transaction(function () use ($pending, $deviceName): ApiAuthResult {
            $token = $pending->user->createToken($deviceName, StaffTokens::ABILITIES);
            $this->sessions->open($pending, request(), (int) $token->accessToken->getKey());

            return ApiAuthResult::ok($pending->user, $token->plainTextToken);
        });
    }

    public function validateSession(Authenticatable $user, SessionContext $context): SessionVerdict
    {
        if (! $user instanceof User) {
            return SessionVerdict::Revoked;
        }

        $session = $this->sessions->find($context, $user);

        // No portal session bound to this browser session / token (or it was revoked): never trust it.
        if ($session === null || $session->isRevoked()) {
            return SessionVerdict::Revoked;
        }

        $identity = $session->identity;
        $environment = $session->environment;

        if (! $user->is_active || $identity->isDeactivated()) {
            $this->sessions->revoke($session, 'deactivated');

            return SessionVerdict::Revoked;
        }

        if ($environment->key !== $this->environments->activeKey()) {
            $this->sessions->revoke($session, 'environment_switched');

            return SessionVerdict::Revoked;
        }

        $token = $session->token;

        if ($token === null) {
            $this->sessions->revoke($session, 'token_missing');

            return SessionVerdict::Revoked;
        }

        $endpoint = $environment->endpoint();
        $result = $endpoint !== null
            ? $this->gateway->verify($endpoint, $token, fresh: $identity->stale_at !== null)
            : PortalVerifyResult::unavailable(PortalFailure::NOT_CONFIGURED);

        return $this->judge($user, $session, $result, $context);
    }

    public function logout(Request $request): void
    {
        $user = $request->user();

        if ($user instanceof User) {
            $session = $this->sessions->find(SessionContext::fromRequest($request), $user);

            if ($session !== null) {
                $this->sessions->revoke($session, 'logout', upstreamLogout: true);
            }
        }

        $this->guard()->logout();

        if ($request->hasSession()) {
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        }
    }

    public function health(): HealthReport
    {
        $environment = $this->environments->active();

        if ($environment === null) {
            return new HealthReport('down', __('The Auth Portal is not configured.'));
        }

        $status = $this->health->status($environment->key);
        $rejection = $this->health->serviceRejection($environment->key);

        return new HealthReport(
            $status === 'unknown' ? 'ok' : $status,
            $this->healthMessage($status, $rejection !== null),
            [
                'environment' => $environment->key,
                'circuit_open' => $this->breaker->isOpen($environment->key),
                'last_verify_at' => $this->health->lastVerifyAt($environment->key)?->toIso8601String(),
                'service_credential_rejected' => $rejection !== null,
                'observed' => $status !== 'unknown',
            ],
        );
    }

    private function healthMessage(string $status, bool $credentialRejected): ?string
    {
        if ($credentialRejected) {
            return __('The Auth Portal rejected this application\'s service credentials.');
        }

        if ($status === 'down') {
            return __('Auth Portal unreachable.');
        }

        if ($status === 'degraded') {
            return __('The Auth Portal is answering with errors.');
        }

        return null;
    }

    /**
     * Portal login + canonical verify + shadow user + roles. Returns the web verdict and, when it is Ok, the pending
     * login whose portal session the caller opens.
     *
     * @return array{0: AuthResult, 1: PendingPortalLogin|null}
     */
    private function authenticate(string $email, #[SensitiveParameter] string $password): array
    {
        $environment = $this->environments->active();
        $endpoint = $environment?->endpoint();

        if ($environment === null || $endpoint === null) {
            return [AuthResult::unavailable(__('The Auth Portal is not configured. Contact an administrator.')), null];
        }

        $login = $this->gateway->login($endpoint, $email, $password);

        if ($login->status === PortalStatus::Invalid) {
            return [AuthResult::invalid(), null];
        }

        if (! $login->isOk() || $login->token === null) {
            return [AuthResult::unavailable($this->unreachableMessage()), null];
        }

        $token = $login->token;

        // New logins fail closed when our service credential is rejected (no /auth/me fallback).
        $verify = $this->gateway->verify($endpoint, $token, fresh: true, userTokenFallback: false);

        if (! $verify->isActive() || $verify->claims === null) {
            $this->discard($endpoint, $token);

            return [match ($verify->status) {
                PortalStatus::ServiceRejected => AuthResult::unavailable(__('Sign-in is unavailable: the Auth Portal rejected this application\'s service credentials. Contact an administrator.')),
                PortalStatus::Inactive => AuthResult::invalid(),
                default => AuthResult::unavailable($this->unreachableMessage()),
            }, null];
        }

        $claims = $verify->claims;
        $decision = $this->roles->decide($claims->roles, $claims->permissions);

        $synced = $this->shadow->upsert($environment, $claims, createIfMissing: $decision->hasChatAccess());

        if (! $synced->isSynced() || $synced->user === null || $synced->identity === null) {
            $this->discard($endpoint, $token);

            return [$this->refusal($synced), null];
        }

        $user = $synced->user;
        $this->roles->syncFromIdentity($user, $synced->identity);
        $user->refresh();

        if (! $user->hasChatAccess()) {
            $this->discard($endpoint, $token);

            return [AuthResult::noChatAccess($user, __('This account has no access to the chat dashboard. Ask an administrator to grant it.')), null];
        }

        $pending = new PendingPortalLogin($user, $synced->identity, $token);
        app(PendingPortalLogins::class)->put($pending);

        return [AuthResult::ok($user), $pending];
    }

    private function refusal(ShadowSyncResult $synced): AuthResult
    {
        return match ($synced->refusal) {
            ShadowSyncResult::IDENTITY_DEACTIVATED, ShadowSyncResult::ACCOUNT_DEACTIVATED => AuthResult::invalid(__('This account has been deactivated. Contact an administrator.')),
            ShadowSyncResult::EMAIL_CONFLICT => AuthResult::invalid(__('This email address already belongs to a local account. Contact an administrator.')),
            ShadowSyncResult::NOT_CREATED => AuthResult::noChatAccess(null, __('This account has no access to the chat dashboard. Ask an administrator to grant it.')),
            // Deliberately the plain "wrong credentials" answer: it must not tell a stranger that the email exists here.
            ShadowSyncResult::IDENTITY_CONFLICT => AuthResult::invalid(),
            default => AuthResult::invalid(),
        };
    }

    /** A just-issued upstream token we will not use is closed again: upstream tokens never expire on their own. */
    private function discard(PizzasysEndpoint $endpoint, #[SensitiveParameter] string $token): void
    {
        $this->gateway->logout($endpoint, $token);
    }

    private function unreachableMessage(): string
    {
        return __('Auth Portal unreachable. Please try again in a few minutes.');
    }

    private function judge(User $user, ExternalSession $session, PortalVerifyResult $result, SessionContext $context): SessionVerdict
    {
        $identity = $session->identity;

        if ($result->status === PortalStatus::Inactive) {
            // The portal no longer knows this token (logged out elsewhere, user deleted): nothing to log out upstream.
            $this->sessions->revoke($session, 'upstream_inactive');

            return SessionVerdict::Revoked;
        }

        if ($result->isActive() && $result->claims !== null) {
            if ($result->claims->sub !== $identity->external_id) {
                $this->sessions->revoke($session, 'identity_mismatch');

                return SessionVerdict::Revoked;
            }

            if ($result->fromCache && $identity->stale_at === null) {
                $this->bind($session, $context);

                return SessionVerdict::Fresh;
            }

            $identity->forceFill([
                'roles' => $result->claims->roles,
                'permissions' => $result->claims->permissions,
                'active' => true,
                'last_verified_at' => now(),
                'stale_at' => null,
            ])->save();

            $this->roles->syncFromIdentity($user, $identity);
            $user->refresh();

            if (! $user->hasChatAccess()) {
                $this->sessions->revoke($session, 'no_chat_access');

                return SessionVerdict::Revoked;
            }

            $session->forceFill(['last_verified_at' => now(), 'verify_fail_count' => 0]);
            $this->bind($session, $context);

            return SessionVerdict::Revalidated;
        }

        // The portal could not answer (down, slow, circuit open, rejected credential without a usable fallback).
        $session->increment('verify_fail_count');
        $this->bind($session, $context);

        $graceEndsAt = $session->last_verified_at->copy()->addMinutes(max(0, $this->settings->int('auth.pizzasys.grace_minutes', 30)));

        return now()->lessThanOrEqualTo($graceEndsAt) ? SessionVerdict::Degraded : SessionVerdict::Unavailable;
    }

    /** Remember which browser session this portal session currently lives in (the id rotates on login). */
    private function bind(ExternalSession $session, SessionContext $context): void
    {
        if ($context->sessionId !== null && $session->laravel_session_id !== $context->sessionId) {
            $session->laravel_session_id = $context->sessionId;
        }

        if ($session->isDirty()) {
            $session->save();
        }
    }

    private function guard(): StatefulGuard
    {
        /** @var StatefulGuard $guard */
        $guard = $this->auth->guard((string) config('fortify.guard', 'web'));

        return $guard;
    }
}
