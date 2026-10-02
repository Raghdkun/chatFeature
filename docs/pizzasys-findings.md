# pizzasys: empirical findings (local harness)

> Status: verified against a **local throwaway clone** (pizzasys commit `ded3fb0`, SQLite, no queue worker, no NATS, `APP_DEBUG=false`)
> on 2026-09-30. Nothing here was checked against a real deployment. Informs P2 (`PizzasysDriver`, NATS consumer).
> Harness (outside the repo): `/Volumes/Rag/Works/PNE/Repos/chatFeature.harness/` — `run.sh start|serve|stop|status|reset`, `fixtures/*.json`
> (46 redacted samples, copy into `tests/fixtures/pizzasys/` in P2), `secrets.local.env` (local-only tokens, chmod 600, never commit).

## Tokens and sessions

| Question | Finding |
|---|---|
| Token format | `<id>\|<48 alnum chars>` (Sanctum). Service-client tokens are standard base64 (may contain `+ / =`). |
| Lifetime | `sanctum.expiration` is `null`: a fresh login token has `expires_at = NULL` and **never expires**; `token-verify` returns `exp: null`. Only `refresh-token` sets an expiry (exactly 72 h). |
| Second login | Does **not** revoke earlier tokens; a new row per login. |
| `logout` | Deletes only the presented token. |
| `refresh-token` | Deletes **all** of the user's tokens (every device/app), returns only `{token, token_type}`. Never call it on behalf of users. |
| Password change (admin PUT / OTP reset) | Does **not** revoke existing tokens. |
| Deleted user | No deactivation concept (`users` has no `is_active`/status/soft-delete). Deleting via the API removes tokens, so `token-verify` -> `active:false`. A raw DB delete leaves orphan tokens that also verify `active:false`. |

**Consequence for us:** upstream tokens are effectively eternal, so the only revocation signal is `token-verify` (and NATS as a fast hint). Our dashboard
session lifetime is **our own** (Laravel session lifetime + periodic revalidation); "bind session to token exp" from the plan only applies if `exp` is non-null.

## `POST /api/v1/auth/token-verify` (service-to-service)

- Send `Accept: application/json` (otherwise validation failures are 302 redirects and errors are HTML), `Authorization: Bearer <service token>`, body `{service:"pne-chat", token:<raw user token>}`.
- **Any bad user token returns HTTP 200 `{"active":false}`** (garbage, unknown id, wrong secret, expired, revoked, deleted user, a token with a `Bearer ` prefix). No reason code.
- **Service credential problems return HTTP 401, never 403**, with a message: `Unauthorized caller.` (no bearer/wrong scheme/missing `service`), `Unknown service.`, `Invalid service token.`
  (also a valid token of a *different* service), `Service is inactive.`, `Service token expired.`
- A user with no roles returns `active:true` with empty `roles`/`permissions`. `ext.authorized` is `true` / `granted_by:"no-rule"` when no auth rules exist; `authorized:false` still returns 200 -> **ignore `ext.*`**.
- Latency ~9 ms sequential (p95 9.5 ms); login ~200 ms (bcrypt). Every verify writes `service_clients.use_count`. Role/permission changes show up on the next verify (no server cache).
- `roles`/`permissions` in the verify payload are **global Spatie** roles/permissions only; store-scoped permissions appear only in `GET /auth/me` (`all_permissions`, `stores[]`).
- `GET /auth/me` shape: `global_roles[{id,name,guard_name,permissions[]}]`, `global_permissions`, `all_permissions`, `stores[...]`, `summary`.

### Roles/permissions seen per test user (verify payload)

| User | roles | permissions |
|---|---|---|
| admin | `["super-admin"]` | the 8 `manage *` permissions, **no `chat.*`** |
| chatadmin | `[]` | `["chat.admin"]` |
| agent | `[]` | `["chat.agent"]` |
| norole | `[]` | `[]` |
| roleagent (permission via a role) | `["chat-agent-role"]` | `["chat.agent"]` |
| storeuser (store-scoped role only) | `[]` | `[]` |

`super-admin` is special only because pizzasys `config/authz.php` hard-codes `super_roles=['super-admin']`; the role does **not** automatically carry `chat.*`.
PNE Chat must check the role name explicitly (admin = role in `super_roles` **or** permission `chat.admin`; agent = permission `chat.agent`).

## NATS events (by code, all 27 subjects observed in the outbox)

Mechanism: a row in `auth_outbox_events` is written in the same DB transaction; after commit `PublishAuthOutboxEventJob` (queue `default`, 10 tries) publishes it.
Envelope (`type == subject`, always prefixed `auth.v1.`): `{specversion:"1.0", id:<ULID>, type, source:"auth-system", subject, time, datacontenttype, data, meta{correlation_id,causation_id,actor_user_id,actor_type,actor_ip,user_agent}}`.

| Subject (after `auth.v1.`) | Emitted when | `data` keys |
|---|---|---|
| `user.created` | `POST /users` | `user{id,name,email,email_verified_at,created_at,updated_at}`, `roles[]`, `permissions_direct[]` |
| `user.updated` | name/email/password changed | `user_id`, `changed_fields{field:{from,to}}` (**bug: `from == to`; leaks the new bcrypt hash**) |
| `user.deleted` | `DELETE /users/{id}` | `user_id`, `email`, `deleted_at` (this is also our "deactivation") |
| `user.role.assigned` / `.removed` / `.synced` | role changes | `user_id`, `roles[]` (synced: `roles{from,to,added,removed}`) |
| `user.permission.granted` / `.revoked` / `.synced` | direct permission changes | `user_id`, `permissions[]` (synced: `permissions{from,to,added,removed}`) |
| `permission.created/updated/deleted` | permission CRUD | `permission{…}` / `permission_id`,`changed_fields` / `permission_id`,`name`,`guard_name` |
| `role.created/updated/deleted` | role CRUD | `role{…,permissions[]}` / `role_id`,`changed_fields` / `role_id`,`name`,`guard_name` |
| `store.created/updated/deleted` | store CRUD | `store{…}` / `store_id`,`changed_fields` / `store_id`,`store_name` |
| `assignment.role_permission.assigned/revoked/synced` | role<->permission changes | `role_id`, `permissions[]` / `added`,`removed`,`final` |
| `assignment.user_role_store.assigned/removed/toggled/bulk_assigned` | store role assignments | `assignment{…}` / `user_id`,`role_id`,`store_id`,… |
| `assignment.role_hierarchy.created/removed` | hierarchy changes | `hierarchy{…}` / ids |

**Never emitted:** login, logout, refresh, password reset, email verification, service-client CRUD, auth-rule CRUD, and per-user events when a role/permission/store is deleted (the cascade is silent).

Publisher caveats: stream `AUTH_EVENTS` with filter `auth.v1.>`; **the app never creates the stream or any consumer**; `Stream::put()` in basis-company/nats 1.1.2 is a core fire-and-forget publish
(so `published_at` means "written to the socket", not "persisted"), with no `Nats-Msg-Id` -> de-duplicate on the envelope `id`. The consumer side has since been run against a real NATS 2.11 JetStream server (see below); the pizzasys publisher itself was never run with NATS.

## Other risks seen (report to the pizzasys owners, don't depend on them)

No login throttling (440 failures, zero 429); account enumeration (unknown email ~4 ms vs wrong password ~200 ms; `forgot-password` 422 on unknown email); CORS `*`;
service-token rotation has no overlap window; any valid service can verify any user's token (`aud` echoes the `service` field); the auth-rule DSL `**` bug;
email matching is case-sensitive on SQLite (MySQL differs); with `APP_DEBUG=true` 401 bodies contain stack traces;
**the public repo's seeder creates a `super-admin` account with a known password — whoever owns the real instance should confirm it does not exist there.**

## Decisions adopted for P2 (supersede the plan where different)

1. Login stays **server-side** (browser -> our backend -> pizzasys): the upstream token never reaches the browser and we add our own throttling (5/min per IP+email). (The harness agent suggested browser-direct login; rejected.)
2. Verify with `Accept: application/json`; outcomes: `200 active:false` -> revoke our session; verify `401` -> our service credential is bad -> degraded + admin alert (fail closed for new logins, allow existing sessions within the grace window); network error/5xx -> degraded; timeout ~2-3 s.
3. Identity key = `sub` (string), not email. Cache a verify result 30-120 s keyed by `sha256(token)`; re-verify long-lived websocket-backed sessions about every 5 min.
4. Session lifetime = our own session lifetime (+ revalidation), because upstream tokens never expire. Never call `refresh-token` or `logout` upstream on behalf of users (our logout deletes only our session; optional best-effort upstream `logout` of the **same** token is allowed since it deletes only that token).
5. NATS is a **fast-invalidation hint**, not the source of truth. The consumer ensures stream `AUTH_EVENTS` exists (idempotent, setting `auth.nats.ensure_stream`, default on) and its own durable consumer, de-duplicates on envelope `id`, never trusts `user.updated.from`, never logs payloads, flushes cached verifies on `user.*`, `role.deleted`, `permission.deleted`, `assignment.role_permission.*`, `assignment.user_role_store.*`, `store.deleted`. Revocation lag without NATS <= verify TTL.
6. Settings: base URL, service name, service token (encrypted), admin/agent permission names, super-role names (default `super-admin`), verify TTL, re-verify interval, verify timeout.

### As implemented (P2 review; supersedes the wording above where it differs)

- Our login throttle is three counters per minute (`chat.login_throttle`: 5 per email + address, 30 per address, 10 per email), not only 5 per IP + email.
- The verify result is cached for `auth.pizzasys.verify_ttl_seconds` (default **60 s**, 15..300), `active:false` answers for 15 s, single-flight per token; verify timeout `verify_timeout_seconds` (default 3 s). There is no separate "re-verify every 5 min" job: sessions are verified lazily on the request path (websocket sessions arrive with P4).
- Our logout and every login we discard (no chat access, refused link) log out **that one upstream token** best-effort; `refresh-token` is never called.
- `user.deleted` deactivates only the portal **identity** and its sessions; the local user stays active (`chat:auth:reactivate` undoes it). Consumer routing is by CloudEvent `type`, and role/permission/store/hierarchy changes flush every identity (`EventRouter`).
- Still true: nothing here was run against a production pizzasys, and the NATS consumer was exercised against a real NATS 2.11 JetStream server in Docker on 2026-10-01 (stream ensured, durable consumer, ack, de-duplication on the envelope id, malformed/unknown handling, redelivery after a nak; `tests/Feature/Nats/NatsIntegrationTest.php`), but never against pizzasys's own outbox publisher.
