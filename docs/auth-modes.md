# Auth modes

> Status: implemented in P1 (wizard + mode 1) and P2 (mode 2), reviewed and hardened. pizzasys behaviour was read from its source and **verified against a local clone** ([pizzasys-findings.md](pizzasys-findings.md)); nothing was checked against a production instance and a real NATS server was never run (see the checklist at the end).

## Setup wizard

The first run opens `/setup` (guarded by a one-time `SETUP_TOKEN`; it is skipped **only** for `APP_ENV=local` requests that come straight from `127.0.0.1` / `::1` with no proxy headers, so a deployment that forgot `APP_ENV=production` still asks for it and refuses to start without one). Steps:

0. Environment check
1. Choose auth mode (**locked after the wizard**)
2. a. Mode 1: create the first admin. b. Mode 2: production (+ optional testing) domain, service-client name + token, optional NATS. A **live `token-verify` probe** and a **verified portal-admin login** are required before finishing, so nobody locks themselves out.
3. App basics: name, URL, locale, timezone, storage, default idle timeout
4. Run: `migrate --force`, seed defaults (a "General" category + sample widget), write the lock (resumable, flock-guarded)
5. Done. `/setup/*` is 404 from now on.

Still editable after the wizard: domains, the production/testing switch, role-name mapping, NATS/service-token settings.

## Mode 1: local (Fortify)

Starter-kit login with Fortify (2FA, passkeys). `FortifyDriver` + `LocalRoleResolver`: `users.is_admin` / `users.is_agent` derive from `users.role`. The first admin comes from the wizard; on the Agents page admins create agent accounts (always active, always taking chats), deactivate/reactivate them, set their concurrent-chat limit and assign categories. There is no "make admin" action in the dashboard (admins can only switch the `is_agent` flag of admin-role accounts, i.e. whether such an account takes chats).

## Mode 2: pizzasys

[pizzasys](https://github.com/RnD-Experts-Team/pizzasys) (public, Laravel 12) is the external auth portal: Sanctum personal tokens (`id|plain`), spatie/laravel-permission, multi-store (`user_role_store`), NATS JetStream.

### Verified pizzasys endpoints (from source)

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /api/v1/auth/login` | none | Body `{email,password,device?,fcm_token?,client_type?}`. Success `{success,message,data:{user{roles,permissions,stores...},token,token_type:"Bearer"}}`. Failure `401 {success:false,message:"Invalid credentials"}`. |
| `GET /api/v1/auth/me` | user Bearer | Full user data. Used as fallback when the service token is rejected. |
| `POST /api/v1/auth/logout` | user Bearer | |
| `POST /api/v1/auth/refresh-token` | user Bearer | **Revokes all of the user's tokens** and issues a 3-day token. Not called by default. |
| `forgot-password`, `reset-otp-verify`, `reset-password` | none | OTP password-reset flow. |
| `POST /api/v1/auth/token-verify` | **service-client Bearer** | Service-to-service. Body `{service,token,method,path,route_name}` -> `{active,sub,exp,iat,user{id,name,email},roles[],permissions[],ext{authorized,...}}`. |

**Settings > Auth safety rules.** A stored service/NATS token is never reused for a new destination: changing the portal address, the service name or the NATS address (or turning certificate verification off) needs the matching token typed again (`422` on `service_token` / `nats_token`; same in the wizard and `chat:auth:set-env`). An edit of the **active** environment that changes how the portal is called is first tried against the portal with the submitted values and refused (`422`, with the failing checks) when it does not work. Address changes are flagged in the audit log.

Our app must be registered as a pizzasys **service client** (`artisan service-client:create` or the admin API). The service token is stored **encrypted**, per environment.

NATS: JetStream stream `AUTH_EVENTS`, subjects `auth.v1.>`, CloudEvents-style envelope `{specversion,id(ulid),type,source:"auth-system",subject,time,data,meta{correlation_id,actor_user_id,...}}`, published through an outbox. pizzasys uses `basis-company/nats ^1.1`; this project installs `^1.2`.

### Login flow

1. Login form posts to **our** backend (the browser never talks to pizzasys).
2. `POST {base}/api/v1/auth/login`, then immediately `POST /auth/token-verify` (service bearer + user token) for canonical roles/permissions/`exp`.
3. `ShadowUserSync`: match by `(environment, external_id)`, else by email, else create with a NULL password. A new portal id is linked by email **only** when the matched local user has no live (not deactivated) identity in this environment; otherwise the login fails generically (the log carries ids only). The database enforces one live identity per (user, environment) too. Roles are always derived from the identity that was just verified.
4. Refuse the sign-in when the user is neither admin nor agent: the login form shows the dedicated "no chat access" notice (a validation error on the email field plus the flashed `reason=no_chat_access`; `403 no_chat_access` for API callers). No shadow user is created for such a person.
5. Store the encrypted token in `external_sessions`, then `Auth::login`.
6. Mobile: we issue **our own Sanctum token** bound to the same `external_sessions` row. The pizzasys token never leaves the server.

### Outbound address guard

Every address an administrator types in (portal base URL, NATS address) goes through `App\Support\Network\OutboundUrlGuard`, in the validation rules and again right before each outbound call: only canonical IP literals and ordinary host names (no decimal/hex/octal/short forms), names are resolved and **every** address must be public (loopback, private, CGNAT, link-local, unspecified, multicast, the cloud-metadata addresses and IPv4-mapped/NAT64/6to4 forms of those are refused), plain `http` only for local development (`APP_ENV=local`, `localhost`, `127.0.0.1`, `::1`, `*.test`, `*.localhost`). A portal that really lives on a private network (a Docker network, a VPN) needs `PORTAL_ALLOW_PRIVATE_HOSTS=true` (or `APP_ENV=local`); the metadata addresses stay refused regardless. Refusals read like "cannot connect"; the NATS connection test answers every failure with the same sentence and bounds its reads. Connections go to the address that was just validated (`CURLOPT_RESOLVE` for HTTP, the socket itself for NATS). Residual risk: with PHP's stream handler (no curl extension) the HTTP client resolves the name a second time, a DNS-rebinding window of a few milliseconds; the app uses the curl handler.

### NATS TLS

The consumer verifies the NATS certificate **and host name** (CA bundle from `NATS_TLS_CA_FILE`, else the system store; switched off only by the environment's "verify TLS" switch). A `tls://` address, or a `nats://` address to a public host while verification is on, never runs a plaintext session: if the server does not offer TLS the connection fails before the token is written. A plain `nats://` address to a private-network host (`PORTAL_ALLOW_PRIVATE_HOSTS`) may stay plaintext. Limitation: basis-company/nats upgrades after the server's first INFO (STARTTLS style), so "TLS first" (`handshake_first`) servers are not supported.

### Role mapping

| App role | Default pizzasys source | Notes |
|---|---|---|
| Admin | role `super-admin` (locked) **or** permission `chat.admin` | `super-admin` always maps to admin |
| Agent | permission `chat.agent` | Optional pizzasys store scope |

Names are configurable in Settings. Mapping is derived on every verify; it is not editable in the dashboard in mode 2.

### Revalidation, degraded mode, circuit breaker

- `EnsureSessionIsValid` (alias `session.valid`, also in the `web` group) revalidates via a cache fast path (`auth.pizzasys.verify_ttl_seconds`, default **60 s**, 15..300; negative answers 15 s) and a single-flight slow path to `token-verify` (timeout `verify_timeout_seconds`, default 3 s).
- Verdicts: **Fresh** / **Revalidated**, **Revoked** (401 `session_revoked` / redirect to login), **Degraded** (portal unreachable -> allowed within the grace window, `grace_minutes` default 30) and **Unavailable** (grace over: the session is **kept** and the request answers **503 `auth_unavailable`** with `Retry-After: 30`, never 401).
- Circuit breaker: 5 failures in 30 s opens it. Only a portal that is down counts (connect error, timeout, TLS failure, 5xx); a 401 / 422 / 429, any other 4xx or an unreadable answer never does, so a password spray cannot open the circuit.
- Sign-in throttle: 5/min per email + address, 30/min per address, 10/min per email across addresses (`chat.login_throttle`).
- While sessions answer `503` (portal unreachable beyond the grace window) sign-out and **Settings > Auth** (the page, saving/testing an environment, switching the active one) stay reachable, so a wrong address or token can be repaired from the dashboard. The **role mapping** (`PUT /settings/auth/roles`) is deliberately *not* exempt: a session that could not be verified for over the grace window must not change who gets chat access.
- If the service token itself is rejected: fall back to `GET /auth/me` and warn admins.

### Refresh caveat

Default: **never call `refresh-token`**, because it revokes all of a user's tokens across the ecosystem. Session lifetime is `min(session, token exp)`. An optional guarded refresh sits behind a setting with a warning.

### Environments and switching

`auth_environments` holds `production` and `testing` (base URL, service name, encrypted service token, NATS URL/creds, `verify_tls`). Switching from the dashboard requires the admin to **sign in on the target environment as an administrator** (the login is closed again at once, so a bad flip cannot lock everyone out), then revokes the other environment's sessions (the actor's included), restarts the NATS consumer and writes an audit row (`POST /settings/auth/active-environment`, 5/min per user). `chat:auth:switch-env` does the same with no UI and no network. Shadow users are matched by `(environment, external_id)` first, then by email (see the login flow).

**Roles** (`PUT /settings/auth/roles`) refuse a mapping that would remove the saving admin's own administrator access; saving flushes every identity so roles re-resolve on each person's next request.

### NATS consumer

`chat:auth:consume-nats` (supervised; run it as its own compose service with `--instance=main`): a durable **pull** consumer named `pne-chat-<APP_ENV>-<instance>` on `auth.v1.>` (deliver policy `new`: events are only fast-invalidation hints), idempotent via `processed_events` (envelope id; pruned after 30 days, hourly by the consumer and by `chat:auth:prune-events`), acked after the effects committed, up to 5 deliveries with back-off. It creates the stream `AUTH_EVENTS` when missing and `auth.pizzasys.nats.ensure_stream` is on (an existing stream is never altered).
Dispatch is on the CloudEvent `type` (`EventRouter`, because real subject names are unverified): `user.deleted` deactivates that portal **identity** and revokes its sessions and tokens (the local user stays active, so a wrong event is recoverable with `chat:auth:reactivate`, and a portal account re-created with the same email can link again);
`user.created|updated`, `user.role.*`, `user.permission.*` and `assignment.user_role_store.*` mark that identity stale (re-verified on its next request); role/permission/store/hierarchy changes flush every identity; `role.created` / `permission.created` do nothing; unknown types are acked and counted. Nothing is ever read from `user.updated` (it leaks a password hash) and payloads are never logged.
Failures that cannot be processed are appended to the **dead-letter file** `storage/logs/nats-dead-letter.ndjson` (metadata only: ids, type, subject, stream sequence, delivery count, error class).
**Which settings it uses:** the ACTIVE auth environment's NATS address and token (Settings > Auth); the consumer is on while that address is set (`auth.pizzasys.nats.enabled` follows it automatically). `NATS_ENABLED` / `NATS_URL` / ... in `.env` only feed the config-backed provider used in development and tests. Without a NATS address the consumer idles (it never crash-loops under a supervisor); with NATS down it reconnects with back-off. In both cases **the app works unchanged**: revocation lag is then at most the verify TTL.
It re-reads its settings every 30 s, reconnects with exponential back-off (1 to 60 s) and picks up an environment switch or NATS edit through the `auth.nats.restart` cache signal; health (`auth.nats.heartbeat_at`, `last_event_at`, `connected`) feeds the Settings > Auth card.

### Failure modes

| Situation | Behaviour |
|---|---|
| Wrong credentials | pizzasys 401 -> normal login error |
| Valid user, no admin/agent role | Refused at login with the "no chat access" notice (`403 no_chat_access` for API callers) |
| Portal unreachable | Degraded: 30 min grace, then `503 auth_unavailable` (session kept, sign-out and Settings > Auth still work) |
| Repeated portal failures | Circuit breaker opens (5 / 30 s) |
| Service token rejected | Fallback to `/auth/me`, admin warning |
| NATS down | No effect on login; revocation lag <= `verify_ttl` |
| User deleted upstream | Identity deactivated, its sessions revoked (`chat:auth:reactivate` undoes it) |
| Locked out | Break-glass CLI below |

### Break-glass and ops CLI

```bash
php artisan chat:auth:switch-env testing            # switch production/testing without the UI, no network (--force skips the confirmation)
php artisan chat:auth:set-env production --base-url=https://auth.example.com --token-file=/run/secrets/svc   # edit an environment (secret from a file or a hidden prompt, never an argument; nothing is tried against the portal; the token re-entry rule still applies)
php artisan chat:auth:reactivate ada@example.com    # bring back an identity deactivated by a user.deleted event (or pass the portal user id; --env=, --force)
php artisan chat:auth:test [production|testing]     # connection test: reachable, service credential, latency, NATS
php artisan chat:auth:consume-nats --instance=main  # the supervised NATS consumer (--once, --max-messages=)
php artisan chat:auth:prune-sessions                # scheduled daily 03:30: revoke abandoned portal sessions (upstream tokens never expire), delete old revoked rows
php artisan chat:auth:prune-events                  # idempotency ledger retention (also done hourly by the consumer)
php artisan chat:install --mode=local|pizzasys      # non-interactive install from INSTALL_* variables
```

**Token re-entry rule.** A stored service/NATS token is never reused for a new destination, so Settings > Auth, the wizard and `chat:auth:set-env` all ask for the token again when the portal address, the service name or the NATS address changes (or certificate verification is turned off).

## Items verified empirically in P2

Run against a local clone of real pizzasys (SQLite, no NATS) with a service client and seeded users; details in [pizzasys-findings.md](pizzasys-findings.md).

- [x] Login token TTL: login tokens **never expire** (`exp: null`); only `refresh-token` sets a 72 h expiry
- [x] Multi-token behaviour: a second login does **not** invalidate the first
- [x] `refresh-token` semantics: deletes **all** of the user's tokens (never called by default)
- [ ] Real NATS subject names and `type` values under `auth.v1.>`: read from the pizzasys code (27 subjects), **never observed on a real server**; the consumer dispatches on the CloudEvent `type`
- [x] `token-verify` store scoping: `roles`/`permissions` are global Spatie roles/permissions only; store-scoped permissions appear only in `GET /auth/me`
- [ ] Anything against a production pizzasys instance (none was available)
