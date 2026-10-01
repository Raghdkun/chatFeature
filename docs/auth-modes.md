# Auth modes

> Status: design, implemented in P1 (wizard + mode 1) and P2 (mode 2). pizzasys facts below were read from its source; several runtime behaviours are still unverified (see the P2 checklist at the end).

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

Starter-kit login with Fortify (2FA, passkeys). `FortifyDriver` + `LocalRoleResolver`: `users.is_admin` / `users.is_agent` are edited in the dashboard.

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
4. Reject with **403** if the user is neither admin nor agent.
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

- `EnsureSessionIsValid` revalidates via a Redis fast path (`verify_ttl` 120 s) and a single-flight slow path to `token-verify`.
- Verdicts: **Revalidated**, **Revoked**, **Degraded** (portal unreachable -> allowed within a 30 min grace window, then **503, not 401**).
- Circuit breaker: 5 failures in 30 s opens it. Only a portal that is down counts (connect error, timeout, TLS failure, 5xx); a 401 / 422 / 429, any other 4xx or an unreadable answer never does, so a password spray cannot open the circuit.
- Sign-in throttle: 5/min per email + address, 30/min per address, 10/min per email across addresses (`chat.login_throttle`).
- While sessions answer `503` (portal unreachable beyond the grace window) **Settings > Auth** and sign-out stay reachable, so a wrong address or token can be repaired from the dashboard.
- If the service token itself is rejected: fall back to `GET /auth/me` and warn admins.

### Refresh caveat

Default: **never call `refresh-token`**, because it revokes all of a user's tokens across the ecosystem. Session lifetime is `min(session, token exp)`. An optional guarded refresh sits behind a setting with a warning.

### Environments and switching

`auth_environments` holds `production` and `testing` (base URL, service name, encrypted service token, NATS URL/creds). Switching requires a passing connection and a test login, revokes the other environment's sessions, restarts the NATS consumer and writes an audit row. Shadow users are matched by `(environment, external_id)` first, then by email.

### NATS consumer

`chat:auth:consume-nats` (supervised): durable pull consumer on `auth.v1.>`, idempotent via `processed_events`, ack after commit. Handles `user.deleted` (deactivates that portal **identity** and revokes its sessions and tokens; the local user stays active, so a wrong event is recoverable with `chat:auth:reactivate`, and a portal account re-created with the same email can link again) and role/permission changes (mark stale, revalidate) and role/permission changes (mark stale, revalidate). Unknown event types are acked and logged; failures go to a dead-letter file. Dispatch is on the CloudEvent `type`, because real subject names are unverified. **The app works if NATS is down**; revocation lag is then at most `verify_ttl`.

### Failure modes

| Situation | Behaviour |
|---|---|
| Wrong credentials | pizzasys 401 -> normal login error |
| Valid user, no admin/agent role | 403 at login |
| Portal unreachable | Degraded: 30 min grace, then 503 page |
| Repeated portal failures | Circuit breaker opens (5 / 30 s) |
| Service token rejected | Fallback to `/auth/me`, admin warning |
| NATS down | No effect on login; revocation lag <= `verify_ttl` |
| User deleted upstream | Identity deactivated, its sessions revoked (`chat:auth:reactivate` undoes it) |
| Locked out | Break-glass CLI below |

### Break-glass CLI

```bash
php artisan chat:auth:switch-env   # switch production/testing without the UI, no network
php artisan chat:auth:set-env production --base-url=https://auth.example.com --token-file=/run/secrets/svc   # edit an environment (secret from a file or a hidden prompt, never an argument; nothing is tried against the portal)
php artisan chat:auth:reactivate ada@example.com   # bring back an identity deactivated by a user.deleted event (or pass the portal user id)
php artisan chat:auth:test [production|testing]   # connection test
php artisan chat:install --mode=local|pizzasys   # non-interactive install (planned, P1)
```

## Items verified empirically in P2

Run against a Docker clone of real pizzasys with a service client and seeded users; record results here.

- [ ] Login token TTL (the 3-day figure is only confirmed for `refresh-token`)
- [ ] Multi-token behaviour (does a second login invalidate the first?)
- [ ] `refresh-token` semantics (confirm it revokes every token)
- [ ] Real NATS subject names and `type` values under `auth.v1.>`
- [ ] `token-verify` store scoping (does `ext` / `roles` depend on store?)
