# Auth modes

> Status: design, implemented in P1 (wizard + mode 1) and P2 (mode 2). pizzasys facts below were read from its source; several runtime behaviours are still unverified (see the P2 checklist at the end).

## Setup wizard

The first run opens `/setup` (guarded by a one-time `SETUP_TOKEN` unless `APP_ENV=local`). Steps:

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

Our app must be registered as a pizzasys **service client** (`artisan service-client:create` or the admin API). The service token is stored **encrypted**, per environment.

NATS: JetStream stream `AUTH_EVENTS`, subjects `auth.v1.>`, CloudEvents-style envelope `{specversion,id(ulid),type,source:"auth-system",subject,time,data,meta{correlation_id,actor_user_id,...}}`, published through an outbox. pizzasys uses `basis-company/nats ^1.1`; this project installs `^1.2`.

### Login flow

1. Login form posts to **our** backend (the browser never talks to pizzasys).
2. `POST {base}/api/v1/auth/login`, then immediately `POST /auth/token-verify` (service bearer + user token) for canonical roles/permissions/`exp`.
3. `ShadowUserSync`: match by `(environment, external_id)`, else by email, else create with a NULL password.
4. Reject with **403** if the user is neither admin nor agent.
5. Store the encrypted token in `external_sessions`, then `Auth::login`.
6. Mobile: we issue **our own Sanctum token** bound to the same `external_sessions` row. The pizzasys token never leaves the server.

### Role mapping

| App role | Default pizzasys source | Notes |
|---|---|---|
| Admin | role `super-admin` (locked) **or** permission `chat.admin` | `super-admin` always maps to admin |
| Agent | permission `chat.agent` | Optional pizzasys store scope |

Names are configurable in Settings. Mapping is derived on every verify; it is not editable in the dashboard in mode 2.

### Revalidation, degraded mode, circuit breaker

- `EnsureSessionIsValid` revalidates via a Redis fast path (`verify_ttl` 120 s) and a single-flight slow path to `token-verify`.
- Verdicts: **Revalidated**, **Revoked**, **Degraded** (portal unreachable -> allowed within a 30 min grace window, then **503, not 401**).
- Circuit breaker: 5 failures in 30 s opens it.
- If the service token itself is rejected: fall back to `GET /auth/me` and warn admins.

### Refresh caveat

Default: **never call `refresh-token`**, because it revokes all of a user's tokens across the ecosystem. Session lifetime is `min(session, token exp)`. An optional guarded refresh sits behind a setting with a warning.

### Environments and switching

`auth_environments` holds `production` and `testing` (base URL, service name, encrypted service token, NATS URL/creds). Switching requires a passing connection and a test login, revokes the other environment's sessions, restarts the NATS consumer and writes an audit row. Shadow users are matched by `(environment, external_id)` first, then by email.

### NATS consumer

`chat:auth:consume-nats` (supervised): durable pull consumer on `auth.v1.>`, idempotent via `processed_events`, ack after commit. Handles user deactivated/deleted (revoke sessions, requeue the agent's chats) and role/permission changes (mark stale, revalidate). Unknown event types are acked and logged; failures go to a dead-letter file. Dispatch is on the CloudEvent `type`, because real subject names are unverified. **The app works if NATS is down**; revocation lag is then at most `verify_ttl`.

### Failure modes

| Situation | Behaviour |
|---|---|
| Wrong credentials | pizzasys 401 -> normal login error |
| Valid user, no admin/agent role | 403 at login |
| Portal unreachable | Degraded: 30 min grace, then 503 page |
| Repeated portal failures | Circuit breaker opens (5 / 30 s) |
| Service token rejected | Fallback to `/auth/me`, admin warning |
| NATS down | No effect on login; revocation lag <= `verify_ttl` |
| User deactivated upstream | Sessions revoked, agent's chats requeued |
| Locked out | Break-glass CLI below |

### Break-glass CLI

```bash
php artisan chat:auth:switch-env   # switch production/testing without the UI (planned, P2)
php artisan chat:install --mode=local|pizzasys   # non-interactive install (planned, P1)
```

## Items verified empirically in P2

Run against a Docker clone of real pizzasys with a service client and seeded users; record results here.

- [ ] Login token TTL (the 3-day figure is only confirmed for `refresh-token`)
- [ ] Multi-token behaviour (does a second login invalidate the first?)
- [ ] `refresh-token` semantics (confirm it revokes every token)
- [ ] Real NATS subject names and `type` values under `auth.v1.>`
- [ ] `token-verify` store scoping (does `ext` / `roles` depend on store?)
