# Auth mode 2 (pizzasys): data model, interfaces, wizard + settings payloads

> Status: contract v1, **implemented in P2 and reviewed/hardened** (`v0.2.0`; this text is the implemented truth, see "Implemented-truth notes" at the end). Tracks: **2A** backend (driver, shadow users, wizard backend, settings backend), **2B** NATS consumer,
> **2C** frontend (wizard mode-2 screens, Settings > Auth page, login variant). Behavioural facts: [../pizzasys-findings.md](../pizzasys-findings.md).
> Base driver contract: [auth-driver.md](auth-driver.md). Never put real credentials in the repo; tests use fixtures + `Http::fake`.

## Tables (migration block `2026_10_20_*`, additive)

| Table | Columns |
|---|---|
| `auth_environments` | `id`, `key` ('production'\|'testing', unique), `label`, `base_url`, `api_prefix` (default `/api/v1`), `service_name`, `service_token_encrypted` (Crypt), `nats_url` null, `nats_token_encrypted` null, `nats_stream` (default `AUTH_EVENTS`), `verify_tls` bool default true, `last_check_at` null, `last_check_status` ('ok'\|'failed') null, `last_check_message` null, timestamps |
| `user_external_identities` | `id`, `user_id` FK, `auth_environment_id` FK, `external_id` string(64) (= pizzasys `sub`), `roles` json, `permissions` json, `active` bool default true, `last_verified_at` null, `stale_at` null, `deactivated_at` null, timestamps; **unique `(auth_environment_id, external_id)`**, index `user_id`; plus (migration `2026_10_21_000100_*`) a virtual `live_environment_id` (= `auth_environment_id` while `deactivated_at IS NULL`, else NULL) with **unique `(user_id, live_environment_id)`**: **one live identity per (user, environment)**, enforced by the database |
| `external_sessions` | ULID PK, `user_id`, `identity_id`, `auth_environment_id`, `laravel_session_id` null (index), `sanctum_token_id` null, `token_encrypted` (the upstream user token), `last_verified_at`, `verify_fail_count` default 0, `revoked_at` null, `revoked_reason` null, `ip`, `user_agent`, timestamps; index `(user_id, revoked_at)` |
| `processed_events` | `event_id` char(26) PK, `type`, `subject`, `outcome`, `processed_at` (index) |

Settings added to the registry (`app/Domain/Settings/DefaultSettings.php`, owned by **2A** in this phase): `auth.pizzasys.active_env` (`production`), `auth.pizzasys.admin_permission` (`chat.admin`),
`auth.pizzasys.agent_permission` (`chat.agent`), `auth.pizzasys.super_roles` (json list <= 20, default `["super-admin"]`), `auth.pizzasys.verify_ttl_seconds` (60, 15..300),
`auth.pizzasys.grace_minutes` (30, 0..1440), `auth.pizzasys.verify_timeout_seconds` (3, 1..15), `auth.pizzasys.nats.enabled` (false; **kept in step automatically**: on while the active environment has a NATS address, `AuthEnvironmentRepository::syncNatsEnabled()`), `auth.pizzasys.nats.ensure_stream` (true).
Secrets live ONLY encrypted in `auth_environments` (never in plaintext settings, logs, props or the install-state file: the wizard keeps tokens encrypted with `Crypt` until the migration step).

## Shared PHP interface (2A implements, 2B consumes)

```php
namespace App\Auth\Pizzasys\Contracts;

interface IdentityInvalidator
{
    /** Drop cached verify results for this upstream user and mark the identity stale (re-verified on its next request). */
    public function flushForExternalId(string $externalId): void;

    /**
     * user.deleted: deactivate THIS portal identity only (identity.deactivated_at, active=false), revoke its sessions and Sanctum tokens
     * and audit it. The local user stays active (a forged or mistaken event must not lock a person out for good; `chat:auth:reactivate` undoes it,
     * and a portal account re-created with the same email can link again).
     */
    public function deactivateExternalId(string $externalId): void;

    /** role/permission/store changes: mark every identity stale and drop all verify caches. */
    public function flushAll(): void;
}
```
Bound in `AuthModeServiceProvider` (`ExternalIdentityInvalidator`, which only touches the ACTIVE environment's identities).

Cache keys (default cache store) written by 2B, read by 2A for the health card: `auth.nats.heartbeat_at` (ISO), `auth.nats.last_event_at` (ISO), `auth.nats.connected` (bool).
Restart signal: 2A increments `auth.nats.restart` (integer) when the active environment or NATS settings change; the consumer polls it every 30 s (`nats.restart_poll_seconds`) and reconnects.
The consumer reads the ACTIVE environment's NATS block from the database (`DatabaseNatsSettingsProvider`); the `NATS_*` env variables feed only the config-backed provider used in dev/tests, except `NATS_TLS_CA_FILE` (applies everywhere).

## Wizard, mode 2 (extends [setup-wizard.md](setup-wizard.md))

New web routes (guest, pre-install, `EnsureNotInstalled` + `EnsureSetupTokenVerified`, throttled) in `routes/web/setup.php` (owned by 2A for this phase):

| Method + path | Body | Response |
|---|---|---|
| `POST /setup/pizzasys` | `{ environments: { production: Env, testing?: Env }, active_env: 'production'\|'testing', admin_permission, agent_permission, super_roles: string[] }` where `Env = { base_url, api_prefix?, service_name, service_token, nats_url?, nats_token?, clear_nats_token?, verify_tls? }` | redirect to `setup.index` (Inertia form post). Tokens stored encrypted in install state. Validation: `PortalUrl` / `NatsUrl` (https URL, http only in local dev or for localhost/127.0.0.1/::1/*.test/*.localhost; public hosts only unless `PORTAL_ALLOW_PRIVATE_HOSTS`), service name `[A-Za-z0-9._-]{1,64}`. **A stored token is never reused for a new destination**: when `base_url`, `service_name` or `nats_url` changes (or `verify_tls` is turned off) the matching token must be sent again, else `422` with the dotted key `environments.<key>.service_token` / `environments.<key>.nats_token` (`SecretReentry`). Throttle `setup-portal-save` (30/min per IP). |
| `POST /setup/pizzasys/test` | `{ env: 'production'\|'testing' }` | JSON `PortalTestResult` (below). Never echoes tokens. Throttle `setup-portal-test` (10/min per IP). |
| `POST /setup/portal-admin` | `{ email, password }` | JSON `{ ok: true, user: { name, email }, isAdmin: true }` or `{ ok: false, message, code: 'invalid'\|'unavailable'\|'no_chat_access'\|'not_admin' }` (HTTP 200/422). On success the upstream `sub`, name, email, roles are kept in install state (**the upstream token is discarded**). Finishing is blocked until this succeeds. Throttle `setup-portal-admin` (5/min per IP). |

All wizard action routes (everything except the index page and the token form itself) sit behind the **setup-token guard** (`EnsureSetupTokenVerified`): the token is skipped only for `APP_ENV=local` requests whose TCP peer is loopback and which carry no proxy header; everybody else must verify it, and the wizard refuses to run (fail closed) when no `SETUP_TOKEN` is configured.

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

Web routes (Inertia, group `['auth','session.valid','chat.access','admin']`, file `routes/web/settings-auth.php`, controller `Settings\AuthSettingsController`). In mode 1 the page only says "managed by this app" and **every write endpoint answers 404** (before the payload is validated):

| Method + path | Body | Response |
|---|---|---|
| `GET /settings/auth` | | Inertia `settings/auth` with `{ authSettings: AuthSettingsData }` |
| `PUT /settings/auth/environments/{key}` | `{ label?, base_url, api_prefix?, service_name, service_token?, nats_url?, nats_token?, verify_tls? }` (omit a token to keep the stored one; send `null` for nats_token to clear). **Re-entry rule:** changing `base_url`, `service_name` or `nats_url`, or turning `verify_tls` off, without sending the matching token again is `422` on `service_token` / `nats_token`. **Pre-flight:** an edit of the ACTIVE environment that changes how the portal is called is first tried against the portal with the submitted values (`TestPortalConnection`, nothing saved yet); a failing test is `422` with `errors.connection` (summary), `errors.base_url` (not reachable), `errors.service_token` (credential refused) and, for JSON callers, `checks[]`; nothing is saved. | redirect back with a success flash (Inertia form post), or the `422` above. Address changes are flagged (`address_changed`) in the audit row, which never carries a secret. |
| `POST /settings/auth/environments/{key}/test` | | JSON `PortalTestResult`; persists `last_check_*`. Throttle `auth-environment-test` (10/min per user). |
| `POST /settings/auth/active-environment` | `{ env, email, password, confirm: true }` — the admin must be able to **log in on the target environment as an admin** (so a bad flip cannot lock everyone out; that login is closed again at once) | `{ ok: true, redirect: '/login' }` (all sessions of the other environment are revoked, including the actor's, whose browser session is ended too; the NATS consumer is told to restart; an audit row is written) or `422 { ok: false, message, code?, errors? }` with `code` ∈ `not_configured`, `already_active`, `invalid`, `unavailable`, `service_rejected`, `not_admin`. Throttle `auth-environment-activate` (5/min per user). |
| `PUT /settings/auth/roles` | `{ admin_permission, agent_permission, super_roles: string[] }` | redirect back; flushes all identities (`IdentityInvalidator::flushAll`) so roles re-resolve. **Refused with `422` on `admin_permission`** when the new names would remove the saving admin's own administrator access (compared on the identity this very session was verified with). |

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
  environments: PizzasysEnvironmentData[];                         // both keys, production first (empty in mode 1)
  roles: { admin_permission: string; agent_permission: string; super_roles: string[] };
  health: { portal: 'ok' | 'degraded' | 'down' | 'unknown'; circuit_open: boolean; last_verify_at: string | null;
            nats: { enabled: boolean; connected: boolean | null; last_event_at: string | null };
            service_credential_rejected: boolean };                // additive: our service credential answers HTTP 401 (sessions fall back to /auth/me, new sign-ins are refused)
};
```
PHP Data classes (2A): `App\Data\Auth\{PizzasysEnvironmentData, PizzasysSetupData, AuthSettingsData, PortalCheckData, PortalTestResultData}` with `#[TypeScript]`.

## Login (mode 2)

Same `/login` form (email + password) posted to our backend; the driver calls pizzasys `POST {base}/api/v1/auth/login` then `POST /auth/token-verify` (service bearer, `Accept: application/json`).
Outcomes map to messages on `errors.email`: invalid credentials, "Auth Portal unreachable" (Unavailable), no chat access. Our own throttle applies: the `login` limiter has three counters per minute (`config/chat.php` -> `login_throttle`): 5 per email + address, 30 per address, 10 per email across addresses; over any of them is `429`.
Details of caching/grace/circuit breaker: [../auth-modes.md](../auth-modes.md) and [../pizzasys-findings.md](../pizzasys-findings.md) "Decisions adopted for P2".

## Implemented-truth notes (P2 hardening)

- **Secrets are write-only.** No response, Inertia prop, flash, audit row, log line or DevTools record carries a service/NATS token (`dontFlash` in `bootstrap/app.php` lists the flat and the dotted wizard keys; Inertia DevTools redaction knows `service_token`/`nats_token`). `has_service_token` / `has_nats_token` are the only trace.
- **`AuthCapabilities.portalUrl`** is `https://<host>` of a **public DNS name**, otherwise `null` (it reaches anonymous visitors on every page: never the real API address, port, path, IP or internal name; `PortalLabel`).
- **Outbound address guard** (`OutboundUrlGuard`, used by the validation rules and again right before each call): public hosts only, canonical spellings only, every resolved address public, `http` only for local development. `PORTAL_ALLOW_PRIVATE_HOSTS=true` (or `APP_ENV=local`) lifts the private-network refusal for a portal that really lives on a private network; the metadata addresses stay refused. One fixed message for every refusal.
- **NATS TLS:** the consumer verifies certificate and host name (`NATS_TLS_CA_FILE`, else the system store; off only through the environment's `verify_tls` switch; `NATS_VERIFY_TLS` exists only for the config-backed dev/test provider); a `tls://` address, or `nats://` to a public host with verification on, never falls back to plaintext. "TLS first" (`handshake_first`) servers are not supported by the client library. **A real NATS server has not been exercised yet** (the integration test is skipped without `NATS_TEST_URL`).
- **`user.deleted`** deactivates only the portal identity (see `IdentityInvalidator`); `php artisan chat:auth:reactivate <email|portal id> [--env=] [--force]` brings it back. A new portal id links to an existing local user by email only when that user has no live identity in this environment; otherwise sign-in fails generically.
- **Degrade:** when the portal cannot be reached and the grace window (`grace_minutes`, default 30) is over, `SessionVerdict::Unavailable` keeps the session and the middleware answers `503 auth_unavailable` (`Retry-After: 30`; an HTML page for browsers). Exempt routes: `logout`, `settings.auth.edit`, `settings.auth.environments.*`, `settings.auth.active-environment`; **not** `settings.auth.roles.update`. Aliases: `session.valid` (`EnsureSessionIsValid`), `chat.access`, `admin`.
- **Break-glass commands:** `chat:auth:switch-env <env> [--force]` (no network), `chat:auth:set-env <env> [--base-url --service-name --api-prefix --nats-url --clear-nats --verify-tls --token-file --nats-token-file]` (no pre-flight; secrets from a file or a hidden prompt, never argv; the re-entry rule still applies), `chat:auth:test [env]`, `chat:auth:reactivate`, `chat:auth:consume-nats [--once --max-messages= --instance=]`, `chat:auth:prune-events [--days=]`, `chat:auth:prune-sessions [--keep-days=]` (scheduled daily 03:30; revokes sessions not verified for longer than their lifetime + 60 min, because upstream tokens never expire).
- **Verify cache:** positive answers live `verify_ttl_seconds` (default 60), negative answers 15 s, single-flight per token; circuit breaker = 5 failures within 30 s opens it for 30 s (only connect errors, timeouts, TLS failures and 5xx count).
