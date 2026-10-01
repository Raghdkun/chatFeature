# AuthDriver

> Status: contract v1 (P0). P1 implements `FortifyDriver` + the manager; P2 implements `PizzasysDriver`.
> Detail and failure modes: [../auth-modes.md](../auth-modes.md).

```php
namespace App\Auth\Contracts;

interface AuthDriver
{
    /** 'fortify' | 'pizzasys' (matches settings('auth.mode')). */
    public function key(): string;

    /** What the UI may offer for this driver. */
    public function capabilities(): AuthCapabilities;

    /** Web login: authenticates against the `web` guard. Never throws for bad credentials. */
    public function attempt(\Illuminate\Http\Request $request): AuthResult;

    /** Mobile/API login: validates credentials and returns OUR Sanctum token (never an upstream token). */
    public function attemptForApi(array $credentials, string $deviceName): ApiAuthResult;

    /** Called on authenticated requests (cheap, cached): is this session still valid? */
    public function validateSession(\Illuminate\Contracts\Auth\Authenticatable $user, SessionContext $context): SessionVerdict;

    public function logout(\Illuminate\Http\Request $request): void;

    public function health(): HealthReport;
}

enum AuthOutcome: string { case Ok = 'ok'; case Invalid = 'invalid'; case Unavailable = 'unavailable'; case NoChatAccess = 'no_chat_access'; }
enum SessionVerdict: string { case Fresh = 'fresh'; case Revalidated = 'revalidated'; case Revoked = 'revoked'; case Degraded = 'degraded'; }

final readonly class AuthCapabilities
{
    public function __construct(
        public bool $canRegister,
        public bool $canResetPassword,
        public bool $canManage2fa,
        public bool $profileEditable,
        public ?string $portalUrl,
    ) {}
}
```

`AuthResult`, `ApiAuthResult`, `SessionContext`, `HealthReport` are small readonly value objects defined by P1 (1A);
P2 only adds fields via additive changes.

```php
interface RoleResolver
{
    /** Recompute and persist users.is_admin / users.is_agent for this user. */
    public function sync(\App\Models\User $user): void;
}
```

## Rules

- `users.is_admin` / `users.is_agent` (booleans) are the **only** role columns the application reads. Policies, gates, API
  resources and Inertia props use them; nothing else inspects roles/permissions.
- `LocalRoleResolver` (mode 1): derived from `users.role` (`admin` | `agent`), editable by admins.
  `PizzasysRoleResolver` (mode 2): derived from pizzasys roles/permissions, **not** editable locally.
- One `Gate::before` returns `true` for `is_admin`. A user who is neither admin nor agent cannot sign in to the dashboard
  (`AuthOutcome::NoChatAccess`).
- `AuthModeManager extends Illuminate\Support\Manager` resolves the driver from `settings('auth.mode')`. Before install it
  resolves `fortify` without touching the database.
- Fortify wiring lives in `FortifyServiceProvider`/`AuthModeServiceProvider`: in mode 2 registration, password reset, 2FA and
  passkeys are disabled and `Fortify::authenticateUsing()` delegates to the active driver.

## Clarifications from the P1 implementation (binding)

- `attempt()` returns the resolved user but **never logs in**: the Fortify pipeline logs in after the 2FA challenge and calls the authenticator twice, so the
  verdict is memoised per request. `PizzasysDriver` must keep this behaviour.
- Value objects live in `App\Auth\Support`, enums in `App\Auth\Enums`. Registration and other Fortify feature routes are gated by driver capabilities (`EnforceAuthFeatures`).
- `EnsureSessionIsValid` and `EnsureChatAccess` are in the `web` middleware group; the `chat.access` alias is for API groups. A signed-in user with neither role flag is logged out and
  redirected to `/login` with a message (JSON: `403 no_chat_access`). New self-registered users default to neither flag.
- Management/mobile API route groups must use `['auth:sanctum', 'session.valid', 'chat.access']`: `session.valid` (EnsureSessionIsValid) turns away deactivated /
  revoked users even with a live token, `chat.access` turns away users without admin/agent flags. Staff API tokens are issued with ability `staff` and expire after
  `SANCTUM_EXPIRATION_MINUTES` (default 43200 = 30 days); deactivating a user or removing their last chat role deletes their tokens (`User::booted`).
- Staff are never gated on email verification (accounts come from an admin or the auth portal): the dashboard/settings routes use `auth` only.

