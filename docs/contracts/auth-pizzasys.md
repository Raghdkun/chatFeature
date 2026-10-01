# Auth mode 2 (pizzasys): data model, interfaces, wizard + settings payloads

> Status: contract v1 (written before P2). Tracks: **2A** backend (driver, shadow users, wizard backend, settings backend), **2B** NATS consumer,
> **2C** frontend (wizard mode-2 screens, Settings > Auth page, login variant). Behavioural facts: [../pizzasys-findings.md](../pizzasys-findings.md).
> Base driver contract: [auth-driver.md](auth-driver.md). Never put real credentials in the repo; tests use fixtures + `Http::fake`.

## Tables (migration block `2026_10_20_*`, additive)

| Table | Columns |
|---|---|
| `auth_environments` | `id`, `key` ('production'\|'testing', unique), `label`, `base_url`, `api_prefix` (default `/api/v1`), `service_name`, `service_token_encrypted` (Crypt), `nats_url` null, `nats_token_encrypted` null, `nats_stream` (default `AUTH_EVENTS`), `verify_tls` bool default true, `last_check_at` null, `last_check_status` ('ok'\|'failed') null, `last_check_message` null, timestamps |
| `user_external_identities` | `id`, `user_id` FK, `auth_environment_id` FK, `external_id` string(64) (= pizzasys `sub`), `roles` json, `permissions` json, `active` bool default true, `last_verified_at` null, `stale_at` null, `deactivated_at` null, timestamps; **unique `(auth_environment_id, external_id)`**, index `user_id` |
| `external_sessions` | ULID PK, `user_id`, `identity_id`, `auth_environment_id`, `laravel_session_id` null (index), `sanctum_token_id` null, `token_encrypted` (the upstream user token), `last_verified_at`, `verify_fail_count` default 0, `revoked_at` null, `revoked_reason` null, `ip`, `user_agent`, timestamps; index `(user_id, revoked_at)` |
| `processed_events` | `event_id` char(26) PK, `type`, `subject`, `outcome`, `processed_at` (index) |

Settings added to the registry (`app/Domain/Settings/DefaultSettings.php`, owned by **2A** in this phase): `auth.pizzasys.active_env` (`production`), `auth.pizzasys.admin_permission` (`chat.admin`),
`auth.pizzasys.agent_permission` (`chat.agent`), `auth.pizzasys.super_roles` (json list, default `["super-admin"]`), `auth.pizzasys.verify_ttl_seconds` (60, 15..300),
`auth.pizzasys.grace_minutes` (30), `auth.pizzasys.verify_timeout_seconds` (3), `auth.pizzasys.nats.enabled` (false), `auth.pizzasys.nats.ensure_stream` (true).
Secrets live ONLY encrypted in `auth_environments` (never in plaintext settings, logs, props or the install-state file: the wizard keeps tokens encrypted with `Crypt` until the migration step).

## Shared PHP interface (2A implements, 2B consumes)

```php
namespace App\Auth\Pizzasys\Contracts;

interface IdentityInvalidator
{
    /** Drop cached verify results for this upstream user and mark the identity stale (re-verified on its next request). */
    public function flushForExternalId(string $externalId): void;

    /** user.deleted / "deactivation": revoke all sessions + Sanctum tokens, set users.is_active=false and identity.deactivated_at. */
    public function deactivateExternalId(string $externalId): void;

    /** role/permission/store changes: mark every identity stale and drop all verify caches. */
    public function flushAll(): void;
}
```
Bound in `AuthModeServiceProvider`. Until 2A merges, 2B tests use an in-memory fake implementing it.

Cache keys (default cache store) written by 2B, read by 2A for the health card: `auth.nats.heartbeat_at` (ISO), `auth.nats.last_event_at` (ISO), `auth.nats.connected` (bool).
Restart signal: 2A increments `auth.nats.restart` (integer) when the active environment or NATS settings change; the consumer polls it every 30 s and reconnects.

## Wizard, mode 2 (extends [setup-wizard.md](setup-wizard.md))

New web routes (guest, pre-install, `EnsureNotInstalled` + `EnsureSetupTokenVerified`, throttled) in `routes/web/setup.php` (owned by 2A for this phase):

| Method + path | Body | Response |
|---|---|---|
| `POST /setup/pizzasys` | `{ environments: { production: Env, testing?: Env }, active_env: 'production'\|'testing', admin_permission, agent_permission, super_roles: string[] }` where `Env = { base_url, service_name, service_token, nats_url?, nats_token?, verify_tls? }` | redirect to `setup.index` (Inertia form post). Tokens stored encrypted in install state. Validation: https URL (http only for localhost/127.0.0.1/*.test), service name `[A-Za-z0-9._-]{1,64}`. |
| `POST /setup/pizzasys/test` | `{ env: 'production'\|'testing' }` | JSON `PortalTestResult` (below). Never echoes tokens. |
| `POST /setup/portal-admin` | `{ email, password }` | JSON `{ ok: true, user: { name, email }, isAdmin: true }` or `{ ok: false, message, code: 'invalid'\|'unavailable'\|'no_chat_access'\|'not_admin' }` (HTTP 200/422). On success the upstream `sub`, name, email, roles are kept in install state (**the upstream token is discarded**). Finishing is blocked until this succeeds. |

`SetupData` (generated type `App.Data.Setup.SetupData`) gains `pizzasys: PizzasysSetupData | null` (non-null only when `mode === 'pizzasys'`), and `pizzasysAvailable` becomes `true`.
Wizard screen order for mode 2: `welcome` -> `mode` -> **`pizzasys`** (environments + roles + test buttons) -> **`portal-admin`** (verified admin login) -> `basics` -> `run` -> `done`; `admin` is skipped.
`SetupStepKey` therefore gains `'pizzasys' | 'portal-admin'`. Run steps for mode 2: `run-migrations`, `seed-defaults` (also writes `auth_environments` + settings), `create-admin` (creates the shadow user + identity for the verified portal admin, `is_admin=true`), `write-lock`.

```ts
type PizzasysSetupData = {
  environments: { production: PizzasysEnvironmentData; testing: PizzasysEnvironmentData };  // from the install state; never tokens
  active_env: 'production' | 'testing';
  roles: { admin_permission: string; agent_permission: string; super_roles: string[] };
  tested: { production: boolean; testing: boolean };       // last PortalTestResult.ok per environment
  portal_admin: { name: string; email: string } | null;     // verified in this wizard run
};
```

## Settings > Auth page (admin only; mode 2 only, mode 1 shows "managed by this app")

Web routes (Inertia, group `['auth','session.valid','chat.access','admin']`, file `routes/web/settings-auth.php`, controller `Settings\AuthSettingsController`):

| Method + path | Body | Response |
|---|---|---|
| `GET /settings/auth` | | Inertia `settings/auth` with `{ authSettings: AuthSettingsData }` |
| `PUT /settings/auth/environments/{key}` | `{ label?, base_url, service_name, service_token?, nats_url?, nats_token?, verify_tls? }` (omit a token to keep the stored one; send `null` for nats_token to clear) | redirect back (validation errors via Inertia) |
| `POST /settings/auth/environments/{key}/test` | | JSON `PortalTestResult`; persists `last_check_*` |
| `POST /settings/auth/active-environment` | `{ env, email, password, confirm: true }` — the admin must be able to **log in on the target environment as an admin** (so a bad flip cannot lock everyone out) | `{ ok: true, redirect: '/login' }` (all sessions of the other environment are revoked, including the actor's; the NATS consumer is told to restart; an audit row is written) or `422 { ok: false, message }` |
| `PUT /settings/auth/roles` | `{ admin_permission, agent_permission, super_roles: string[] }` | redirect back; flushes all identities (`IdentityInvalidator::flushAll`) so roles re-resolve |

```ts
type PizzasysEnvironmentData = {
  key: 'production' | 'testing'; label: string; configured: boolean;
  base_url: string | null; service_name: string | null; has_service_token: boolean;
  nats_url: string | null; has_nats_token: boolean; verify_tls: boolean;
  last_check_at: string | null; last_check_status: 'ok' | 'failed' | null; last_check_message: string | null;
};
type PortalCheck = { key: 'reachable' | 'service_credential' | 'latency' | 'nats'; label: string; ok: boolean; message?: string };
type PortalTestResult = { ok: boolean; checks: PortalCheck[] };   // service_credential = token-verify probe with a dummy token must return HTTP 200 {active:false}
type AuthSettingsData = {
  mode: 'fortify' | 'pizzasys'; active_env: 'production' | 'testing';
  environments: PizzasysEnvironmentData[];                         // both keys, production first
  roles: { admin_permission: string; agent_permission: string; super_roles: string[] };
  health: { portal: 'ok' | 'degraded' | 'down' | 'unknown'; circuit_open: boolean; last_verify_at: string | null;
            nats: { enabled: boolean; connected: boolean | null; last_event_at: string | null } };
};
```
PHP Data classes (2A): `App\Data\Auth\{PizzasysEnvironmentData, PizzasysSetupData, AuthSettingsData, PortalCheckData, PortalTestResultData}` with `#[TypeScript]`.

## Login (mode 2)

Same `/login` form (email + password) posted to our backend; the driver calls pizzasys `POST {base}/api/v1/auth/login` then `POST /auth/token-verify` (service bearer, `Accept: application/json`).
Outcomes map to messages on `errors.email`: invalid credentials, "Auth Portal unreachable" (Unavailable), no chat access. Our own throttle (5/min per IP+email) applies. Details of caching/grace/circuit breaker: [../auth-modes.md](../auth-modes.md) and [../pizzasys-findings.md](../pizzasys-findings.md) "Decisions adopted for P2".
