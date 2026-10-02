# Mobile readiness (staff app)

> Status: review written in P7 (track 7B), 2026-10-02. Scope: everything a **native staff app** (iOS/Android, agents and admins) needs from the server. The visitor side is covered by [api-guide.md](api-guide.md).
> "Verified" means run against a local instance with real HTTP (and a real Reverb for the realtime items) in this track; "tested" means a PHPUnit test; "read" means derived from the code only.
> Estimates are engineering days for one developer including tests and docs.

## Verdict in one paragraph

The staff **API is complete enough for an agent app** (inbox, messages, attachments, claim, transfer, end, presence, notification settings, categories) and the realtime path works with a bearer token. A mobile app **cannot ship yet** because of three things: (1) there is **no HTTP sign-in endpoint** (the drivers can issue tokens, nothing exposes it; and a naive endpoint would bypass 2FA), (2) there is **no real FCM channel** (the `POST /me/devices` registration is a stub, so a backgrounded app is effectively offline after 90 seconds), and (3) a few small conveniences are missing (listed below). This track added the credential endpoints a client needs once it has a token (`auth/me`, `auth/tokens`, revoke, logout) and the realtime address in `auth/me`.

## Checklist and verdicts

| # | Need | Verdict | Detail |
|---|---|---|---|
| 1 | Sign in, mode 1 (Fortify): token with a device name | **Gap (blocking), 1.5 days** | `FortifyDriver::attemptForApi()` issues `createToken($deviceName, ['staff'])` (tested) but **no HTTP route calls it**. See "Sign-in design" |
| 2 | Sign in, mode 2 (pizzasys) | **Gap (same endpoint), +0.5 day** | `PizzasysDriver::attemptForApi()` logs in at the portal, verifies, syncs the shadow user and issues **our own** Sanctum token bound to the `external_sessions` row; the portal token never leaves the server (tested). Needs the same endpoint plus `auth_unavailable` handling |
| 3 | 2FA at sign-in | **Gap, included in 1** | `attemptForApi` checks the password only. A route that returned a token for a user with two-factor enabled would **skip the second factor**: the endpoint must challenge (TOTP or recovery code) or refuse such accounts |
| 4 | Passkeys | **Gap (large), 3 to 5 days, defer** | Fortify passkeys are session/WebAuthn-ceremony based and web-only. A native app needs the platform credential APIs, `apple-app-site-association` / `assetlinks.json` and a token-issuing assertion endpoint. Password (+TOTP) first |
| 5 | Token abilities | **Ready, hardening optional 0.25 day** | Both drivers issue only `['staff']`. No route checks the ability (no other token kind exists). Adding `CheckForAnyAbility:staff` to the management group would make a future second token kind safe by default |
| 6 | Expiry and lifetime | **Ready, decision needed** | Absolute: `SANCTUM_EXPIRATION_MINUTES` (default 43200 = 30 days) from issue, **no sliding, no refresh**. `expiresAt` is in `auth/me` and `auth/tokens`. The user signs in again after 30 days; a rotate-in-place `POST /auth/token/refresh` is 0.5 day if wanted. Mode 2 portal tokens never expire upstream; `chat:auth:prune-sessions` revokes sessions unverified for lifetime + 1 h |
| 7 | List and revoke own tokens | **Done (this track)** | `GET /auth/tokens`, `DELETE /auth/tokens/{id}` (own tokens only, `404 token_not_found` for anyone else's, IDOR-tested), mode 2 also ends the portal session and logs the portal token out upstream (tested) |
| 8 | Logout | **Done (this track)** | `POST /auth/logout` revokes **only the current token**; with the dashboard cookie it answers `409 not_a_token_session`. The app also deletes its stored token and socket |
| 9 | Who am I, driver, capabilities, clock | **Done (this track)** | `GET /auth/me`: user, `mode`, `capabilities`, the token of the call, `realtime` (public Reverb address) and `serverTime` |
| 10 | Revocation reaches the app | **Ready** | Deactivating an account or removing its last chat role deletes its tokens (tested): the next call is `401`. Mode 2: a revoked or deleted portal identity ends the session (NATS event, else within the 60 s verify TTL). A live socket also gets `session.revoked` on `private-staff.{id}`: confirm with REST (`401`) before dropping the session |
| 11 | Portal outage (mode 2) | **Ready** | Inside the grace window (30 min) requests pass; after it `503 auth_unavailable` with `Retry-After: 30` and the **token is kept**: never sign the user out on a 503 |
| 12 | Inbox list, detail, search, filters | **Ready** | `GET /conversations` (`status`, `category`, `widget`, `agent=me`, `type`, `q`, `from`/`to`, `limit` <= 100, opaque `cursor`), `GET /conversations/queue`, `GET /conversations/{ulid}` |
| 13 | Messages and gap sync | **Ready** | `GET .../messages?after_seq=N&limit=` ascending by `seq`; `POST .../messages` with `client_msg_id` (idempotent: an offline outbox can retry blindly; replay is `200`) |
| 14 | Attachment upload from native | **Ready** | `POST .../attachments`, multipart field `file` (JPEG/PNG/WebP/still GIF, 5 MB, 4096 px by default; verified with curl `-F` on the visitor twin, contract-tested for staff). The server re-encodes (EXIF stripped, orientation applied) and makes a 320 px thumbnail; send the original, resizing is optional. The limits are in the **visitor** `limits` block only: a staff client hard-codes the defaults or reads the `422` (`details.file`) |
| 15 | Claim, transfer, end, close | **Ready** | `POST .../claim` (atomic; `409 already_claimed` with `details.by`), `transfer` + `GET .../transfer-targets`, `end`, `close` (offline tickets, admin) |
| 16 | Presence: foreground | **Ready** | `PUT /me/presence {status, automatic}` once, then `POST /me/presence/heartbeat {visible}` every 30 s; the answer is the **effective** status |
| 17 | Presence: backgrounded app | **Gap (needs 18), product decision** | The server calls an agent offline after **90 s** without a heartbeat. iOS/Android suspend an app within seconds of leaving the foreground, so a mobile-only agent is `offline` in the background and gets no offers. `visible: false` only matters while beats keep coming (then `away` after 5 minutes). Design choices: treat the app as available only in the foreground plus push wake-ups, or let routing count push-registered offline agents (the planned `wake_offline_via_push` widget flag, **not implemented**, 2 days + decision) |
| 18 | Push to devices (FCM) | **Gap (blocking for background use), 3 to 4 days** | `POST /me/devices` stores the token (**encrypted**, upsert by hash, moves to the caller, never returned) and `DELETE /me/devices/{id}`; `FcmChannel` is a **stub** (`PUSH_FCM_ENABLED` only makes it log). What a real channel still needs is listed below |
| 19 | Device registry conveniences | **Gap (small), 0.75 day** | No `GET /me/devices` (the app cannot check its registration), and a device is not tied to the token that registered it: the app must `DELETE /me/devices/{id}` on sign-out (a revoked token otherwise leaves a registration that keeps receiving pushes for that user) |
| 20 | Notification preferences | **Ready** | `GET/PUT /me/notification-settings` (sound, offers, messages, previews, quiet hours in the member's timezone; server-side). Quiet hours are enforced by the server when it sends |
| 21 | Realtime with a bearer | **Ready (verified)** | `POST /broadcasting/auth` (outside `/api`, form fields `socket_id`, `channel_name`) accepts `Authorization: Bearer`; CSRF does not apply to that route (the framework excludes it). Subscribed over a real Reverb: `private-staff.{own id}` 200, `private-admin` as an agent 403. `GET /auth/me` now carries `realtime: {key, host, port, scheme}` |
| 22 | Websocket handshake | **Ready, one trap (verified)** | Reverb refuses a handshake without an allowed `Origin` (`4009 Origin not allowed`): a native client must send `Origin: https://<app host>` (the host of `APP_URL`, or an entry of `REVERB_ALLOWED_ORIGINS`). It is a browser control, not security: any client can send it |
| 23 | Reconnect and gap rules | **Ready** | Per conversation keep the highest `seq`; on reconnect/foreground/`seq` gap call `GET .../messages?after_seq=` and `GET /conversations?updated_after=<newest updatedAt you hold>` (inclusive, merge by `ulid`). Counters in events are absolute. Events are never the only source |
| 24 | Deep links | **Ready server side, small gap, 0.5 day** | Push payloads carry `data.url` = `/inbox/{ulid}` (path on the app host; the dismiss push `/inbox`). The app maps it to its screen. Universal Links / App Links need `/.well-known/apple-app-site-association` and `assetlinks.json` served by the web server: the application serves neither |
| 25 | Clock skew | **Ready** | `serverTime` in `auth/me` and the HTTP `Date` header of every answer; compare with the device clock once and apply the difference. Timestamps are ISO-8601 UTC with milliseconds. `queueExpiresAt` is absolute (so correct it by the skew); the realtime offer carries `ttlSeconds` (count down from arrival). The REST queue has no per-offer `ttlSeconds` (minor) |
| 26 | Pagination, ETag, conditional requests | **Partly, 0.5 day** | Cursor pagination everywhere (`meta.next_cursor`, opaque; messages by `seq`). `ETag`/`If-None-Match` exist only on the **public** config and availability. Staff lists have none: use `updated_after` for incremental sync |
| 27 | Images | **Ready** | Signed `url` / `thumbUrl` (320 px) live `chat.attachment_url_ttl_minutes` (240): load them with **no** `Authorization` header, cache the bytes not the URL, re-read the message for a fresh one |
| 28 | Error mapping | **Ready** | Table below |
| 29 | Versioning and deprecation | **Ready (policy), small gap, 0.5 day** | `/api/v1`, additive changes only, breaking = `/api/v2`. No `Deprecation`/`Sunset` headers and no minimum-app-version endpoint: an app cannot be told to upgrade (a `GET /api/v1/meta` with `minAppVersion` is 0.5 day) |
| 30 | CORS | **Not applicable** | Native clients are not browsers; CORS is off for `api/*` on purpose |
| 31 | TLS and pinning | **Guidance** | Caddy renews certificates automatically (about every 60 days): do **not** pin the leaf. Pin the SPKI of the issuing CA (and a backup) or rely on platform trust; keep the pin set updatable |
| 32 | Rate limits per user | **Ready** | Chat calls: `staff-api` 600 a minute **per user** (all of a user's devices share it); push registration 20, test push 3. A heartbeat is 2 a minute, a dashboard-style poll fallback should not go below 15 s. Admin CRUD routes (categories, agents, widgets) carry **no** limiter today. Each bearer request writes `personal_access_tokens.last_used_at` (Sanctum default): fine for tens of agents, see the load test |
| 33 | Secrets hygiene | **Ready** | Tokens are stored sha256-hashed, never logged (driver parameters are `#[SensitiveParameter]`, dev-tools redaction is tested); keep the app's token in the Keychain / Keystore, send it only in the `Authorization` header, drop it on `401` |
| 34 | Profile (name, avatar, password, 2FA setup) | **Gap (small), 1 day** | Only web pages (`/settings/profile`, `/settings/security`); no JSON endpoints. An app links out to the web for these, or gets `GET/PATCH /me` and `PUT /me/password` |
| 35 | Staff list for transfer, roster | **Ready** | `GET .../transfer-targets` gives colleagues with presence and load; `/agents` is admin-only; the roster is the `presence-staff` channel |

## Error mapping for the app

| Answer | The app should |
|---|---|
| `401 unauthenticated` | token unknown or already revoked: sign out locally and show the sign-in screen |
| `401 session_revoked` | deactivated, role removed, portal session ended: sign out, show the server's message |
| `403 no_chat_access` | signed in but no admin/agent role: explain, offer sign out |
| `403 forbidden` | not allowed (an agent on an admin route, another agent's chat): hide the action; do not sign out |
| `404 not_found` / `token_not_found` / `device_not_found` | the thing is gone (or not yours): refresh the list |
| `409 already_claimed` (`details.by`), `conversation_not_queued`, `at_capacity`, `conversation_not_active`, `no_agents` (`details.target`, `details.reason`) | expected outcomes: update the UI, no error toast needed beyond the message |
| `422 validation_failed` | map `details` to fields |
| `429 rate_limited` | wait `Retry-After` seconds |
| `503 auth_unavailable` | keep the session, retry after `Retry-After` (30 s) |
| `5xx`, timeout, no network | retry with back-off; message sends carry `client_msg_id` so a retry cannot duplicate |

## Sign-in design (the blocking gap, 1.5 to 2 days)

A password sign-in endpoint is deliberately **not** in this track: it is a new unauthenticated surface that handles credentials and a second factor, and it needs a security review of its own. The design it should follow:

- `POST /api/v1/auth/token { email, password, device_name, code?, recovery_code? }` in the `widget`-style bearer-only stack (no session, no cookies, no CSRF), unauthenticated, behind the existing `login` limiter (5 per email and address, 30 per address, 10 per email, per minute) and a Timebox as `FortifyDriver` already does.
- It calls `AuthDriver::attemptForApi($credentials, $deviceName)`, so both modes work and the password check, deactivation check and "no chat access" refusal are the drivers' own (`invalid`, `no_chat_access`, `unavailable` outcomes map to `401 invalid_credentials`, `403 no_chat_access`, `503 auth_unavailable`).
- **Two-factor:** in mode 1, if `two_factor_confirmed_at` is set, issue the token only after a valid `code` (TOTP through Fortify's `TwoFactorAuthenticationProvider`) or an unused `recovery_code` (consumed); otherwise answer `422 two_factor_required` **without** issuing a token (the password was right, so tell the app to ask for the code and repeat the call). Rate limit the code step with the `two-factor` limiter. A route that skipped this would turn a stolen password into a full bypass of 2FA.
- `device_name` (3 to 60 printable characters) is shown in `GET /auth/tokens`: store it as plain text, render it escaped. Cap the number of live tokens per user (for example 10; the oldest unused go first), like push subscriptions.
- Answer `201 { data: { token, tokenType: "Bearer", expiresAt, user, ... } }` with `Cache-Control: no-store`; the token string is shown once. Audit `auth.token.issued` (device name and IP, never the token).
- Tests: wrong password, unknown user (same answer and timing), deactivated, no chat access, 2FA required / wrong / recovery code, throttling, mode 2 with the portal mock (including outage), token works on `auth/me`, abilities, never logged.

## What a real FCM channel still needs (the stub today)

`FcmChannel implements PushChannel` exists and only logs while `push.fcm.enabled` is on. To make it real (3 to 4 days):

1. **Credentials and config:** a Firebase service account (JSON) kept in an **encrypted setting** (like the VAPID/OpenWA secrets, write-only in Settings), `push.fcm.project_id`, an OAuth2 access-token fetch (JWT bearer grant, cached for its lifetime) for the FCM HTTP v1 API `POST https://fcm.googleapis.com/v1/projects/{id}/messages:send`; the outbound URL guard and timeouts like `PushHttpClient`.
2. **Mapping `PushMessage`:** `data` = `{v, type, tag, url}` (`/inbox/{ulid}`); a `notification` block for offer/message pushes; `android.priority` high and `ttl` = `PushMessage::$ttl` (an offer's TTL is the time it has left); `apns-priority`/`apns-expiration`; the **tag** becomes `android.notification.tag` and `apns-collapse-id` so a newer push replaces the old one; the silent **dismiss** is a data-only high-priority message that the app turns into a cancel of that tag; respect quiet hours and previews exactly as `WebPushChannel` does (`NotificationPreferences`).
3. **Token hygiene:** `UNREGISTERED` / `INVALID_ARGUMENT` / 404 delete the `device_tokens` row (and count it in the test push result, like `removed`), 5xx and timeouts become `retry` in the `PushResult`; never log a token.
4. **Delivery:** `PushDispatcher` already loops over channels and treats a disabled one as a no-op; add the FCM channel's result handling to `SendTestPush` (`POST /me/push-subscriptions/test` should try devices too) and tests with `Http::fake`.
5. **iOS:** through FCM with an APNs key uploaded to Firebase; background delivery needs `content-available` for the dismiss push.
6. **Product:** decide whether a push-registered offline agent counts as reachable for routing (item 17).

## What this track added

- `GET /api/v1/auth/me`, `GET /api/v1/auth/tokens`, `DELETE /api/v1/auth/tokens/{id}`, `POST /api/v1/auth/logout` (`StaffAuthController`, `App\Auth\Tokens\StaffTokens`, `ApiTokenData`, `StaffMeData`); 16 tests in `tests/Feature/Auth/StaffTokensApiTest.php` (IDOR, mode 2 with the portal mock, expiry, cookie vs bearer, no secrets in answers).
- The generated reference (`docs/api/openapi-*.yaml`), the rot guard and the contract tests that make this document's API claims checkable.
- Verified with real HTTP on a local instance: bearer on `/broadcasting/auth`, staff and visitor channel subscriptions over a real Reverb, the Reverb `Origin` requirement, the CORS preflight behaviour of the public endpoints, 429/`Retry-After`, and the full visitor flows of the guide.
