# REST conventions and shapes

> Status: contract v1. The conventions and the **P3 widget/category/agent endpoints are implemented and reviewed** (`v0.3.0`; this text is the implemented truth). The P4 chat endpoints below are still the plan, written ahead of the P4 fan-out.
> Full endpoint inventory: [../rest-api.md](../rest-api.md).

## Conventions (all APIs)

- Base: management `/api/v1/*` (Sanctum, cookie for the dashboard / bearer for mobile; route group `['auth:sanctum','session.valid','chat.access']` + `admin` where marked); public visitor API `/api/v1/public/*`
  (`widget` middleware group, bearer visitor token from P4 — **no cookies, no CSRF, never stateful**); webhooks `/webhooks/*`.
- Success: `{ "data": <resource> }`; lists: `{ "data": [...], "meta": { "next_cursor": "…" | null } }` (cursor pagination, `?cursor=&limit=`). In P3 every list is complete and unpaginated: `meta.next_cursor` is always `null`.
- Errors: `{ "error": { "code": "snake_case", "message": "Human readable", "details"?: { field: ["msg"] } } }` with HTTP status
  `400/401/403/404/405/409/419/422/429/500/503`. Validation errors use `422 validation_failed` and `details` keyed by field. Every `api/*` error uses this envelope (`ApiErrorRenderer`);
  a 500 in production is `500 server_error` with a fixed message (no details leak; with `APP_DEBUG` Laravel's own debug output is kept).
- Public identifiers only: `ulid` (conversations, messages, attachments, visitors, widgets, categories, greetings) and `public_key` (widgets): `wk_` + **20 lower-case `[a-z0-9]` characters** (about 103 bits). Lookups accept `wk_[A-Za-z0-9_-]{6,40}` and compare case-sensitively.
  Staff-only management payloads may use the integer user id (`/agents/{id}`).
- Timestamps ISO-8601 UTC with milliseconds (`2026-09-30T12:00:00.000Z`). Message ordering is by `seq` (integer, per conversation).
- Idempotency: write endpoints that create messages accept `client_msg_id` (ULID, client generated) — replays return the original resource with `200`.
- Rate limits: `429 rate_limited` with `Retry-After`. Implemented limiters: `public-config` (per client network, public widget endpoints), `public-config-widget` (per widget + network / allowed origin), `login` (three counters, `chat.login_throttle`),
  `setup-portal-*` and `auth-environment-*` (wizard / Settings > Auth). Planned with P4-P6: `public-session`, `public-message`, `public-upload`, `api`, `wa-webhook`.
- Versioning: path (`/v1`). Additive changes only; breaking changes ship as `/v2`.
- Resources are `spatie/laravel-data` classes with `#[TypeScript]` where the dashboard/loader consume them (serialised through `toArray()`).

### Error codes (implemented)

| Code | Status | When |
|---|---|---|
| `validation_failed` | 422 | Invalid body; `details` keyed by field (widget config: `config.<dotted path>`) |
| `unauthenticated` / `forbidden` / `not_found` / `method_not_allowed` / `bad_request` | 401 / 403 / 404 / 405 / 400 | Generic HTTP errors |
| `csrf_mismatch` | 419 | Dashboard call without a valid XSRF header |
| `session_revoked` | 401 | Session or token ended (deactivated account, upstream revocation) |
| `no_chat_access` | 403 | Signed in but neither admin nor agent |
| `auth_unavailable` | 503 | Mode 2: portal unreachable beyond the grace window; session kept, `Retry-After: 30`; sign-out and Settings > Auth (page, environments, active-environment; **not** the role mapping) stay reachable |
| `not_installed` | 503 | Before the wizard finished (install gate). The body is the bare `{"error":"not_installed"}`, **not** the envelope (`InstallGate` runs before the exception renderer) |
| `widget_not_found` | 404 | Public widget endpoints: unknown, deleted or disabled key (indistinguishable) |
| `origin_not_allowed` | 403 | Public widget endpoints: browser `Origin` not whitelisted (no CORS headers), or no `Origin` and the widget does not allow non-browser clients |
| `category_in_use` | 409 | Deleting a category used by a queued or active conversation (live or offline; `ConversationCategoryUsageChecker`, P4) |
| `slug_taken` | 409 | Category slug already used (also when lost in a race) |
| `managed_by_auth_portal` | 409 | Mode 2: creating accounts or changing `is_active` / `is_agent` |
| `cannot_deactivate_self` | 409 | An admin deactivating their own account |
| `not_an_agent` | 409 | Assigning categories to an account that does not take chats (`is_agent` false) |
| `auth_mode_unavailable` | 500 | Installed instance without a valid `auth.mode` setting (fails closed, reported) |
| `rate_limited` | 429 | Limiter hit; `Retry-After` set |
| `server_error` | 500 | Unhandled exception in production |

## Public widget endpoints (P3)

Middleware order: `ShieldPublicWidgets` (unknown-key probing; CORS on 429) -> `ThrottlePublicNetwork` (per client network, before the key is looked up) -> `AuthorizeWidgetOrigin` (404 / 403 / preflight / CORS) -> `ThrottlePublicWidget`.

### `GET /api/v1/public/widgets/{key}/config?locale=xx`

- `200 { "data": ResolvedBootConfig }` (see [widget-config.md](widget-config.md): `locale`, `api`, `config`, `greetings`, `categories` with `description/icon/color`, `availability` incl. `categories`).
  `ETag` (a hash of the body **without** `generatedAt`; `If-None-Match` -> `304`), `Cache-Control: public, max-age=60, stale-while-revalidate=300`, `Vary: Origin`,
  `Access-Control-Allow-Origin: <origin>` **only** when the request `Origin` matches `widget_domains` (or is this app's own origin).
- `?locale=` is optional; a value that is not a locale tag is ignored. Matching: exact, language, variant of the language, else the widget default (`data.locale` says which); only the default and the resolved text block are returned (all blocks without the parameter).
- `404 widget_not_found` (unknown key or disabled/deleted widget); `403 origin_not_allowed` (browser `Origin` not whitelisted; no ACAO header). Both: `Vary: Origin`, `Cache-Control: no-store`.
- Requests without an `Origin` header (server-to-server, mobile) are allowed only when the widget has `allow_non_browser_clients = true` (or the browser says `Sec-Fetch-Site: same-origin`).
- `OPTIONS` preflight: `204` for allowed origins with `Access-Control-Allow-Methods: GET, OPTIONS`, `Access-Control-Allow-Headers` (the requested subset of `accept, accept-language, content-type, if-none-match, x-requested-with`), `Access-Control-Max-Age: 600`.
- `429 rate_limited` (`Retry-After`): per client network (IPv4 address / IPv6 /64) across all keys 600/min, 60/min for lookups of unknown keys, per network + key 300/min, per key + allowed origin 6000/min (`config/chat.php` `rate_limits`).
  A 429 carries the CORS headers (plus `Access-Control-Expose-Headers: Retry-After`) **only** when that (key, origin) pair was allowed within the last 5 minutes; other origins get none. On the non-API endpoints (`/w/{key}.js`, `/embed/{key}`, `/c/{key}`) a 429 is not JSON: plain text from the unknown-key counter, Laravel's standard 429 response from the limiters.

### `GET /api/v1/public/widgets/{key}/availability`

`200 { "data": { "online": bool, "openNow": bool, "nextOpenAt": "ISO"|null, "categories": [ { "slug": "billing", "online": true } ], "whatsapp": { "enabled": bool } } }`
`ETag`/`304`, `Cache-Control: public, max-age=5`; cached server-side for 8 s and dropped on publish / settings change; same origin rules as `config`. `online` is false until P5 presence; `whatsapp.enabled` false until P6.

### Loader delivery

`GET /w/{key}.js` (web route, not under `/api`, no session/cookies): the loader bundle + inlined `ResolvedBootConfig`, `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=300`, `X-Content-Type-Options: nosniff`.
`GET /widget/v1/loader.js` is the generic loader (reads `data-widget-key` and fetches `config`); when `public/widget/v1/loader.js` exists the web server serves that file itself.

### Iframe page

`GET /embed/{key}[?mode=inline&preview=1]` (web route, no session/cookies): Blade shell for the React panel, `Content-Security-Policy: frame-ancestors <widget_domains>` (`'none'` when the list is empty;
preview: `frame-ancestors 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cache-Control: public, max-age=60` (preview: `private, no-store`), no cookies set.
`?preview=1` is for signed-in **active admins** only (the session cookie is read, then every cookie stripped from the response; anyone else gets `403`) and may also open a disabled widget.
Hosted page `GET /c/{key}` sends `frame-ancestors 'none'`.

## Management endpoints used by P3 (admin only unless noted; all writes are audited)

| Method + path | Notes |
|---|---|
| `GET /categories` (any staff), `POST /categories`, `GET/PATCH/DELETE /categories/{ulid}` (admin) | Agents only see active categories, admins all. `POST` -> `201 CategoryData`. Delete is soft (frees the slug), `204`; rejected with `409 category_in_use` while a queued or active conversation uses it. |
| `GET/PUT /me/categories` (agents, `is_agent`) | Agent self-selection of served categories (replaces the set, active categories only). Both return `{ "data": { "category_ulids": [...] } }`. Staff without `is_agent` (admins who do not take chats) get `403`. |
| `PATCH /agents/{id}/categories` | Admin assigns categories to an agent (mode 1 and mode 2; role flags come from the auth driver). Returns `AgentListItemData`; `409 not_an_agent` when the account does not take chats. |
| `GET /agents`, `POST /agents` (mode 1), `PATCH /agents/{id}` | See dashboard-pages-p3.md; `409 managed_by_auth_portal` in mode 2 for accounts and `is_active` / `is_agent`. |
| `GET/POST /widgets`, `GET/PATCH/DELETE /widgets/{ulid}` | Admin CRUD. `POST {name}` -> `201 WidgetData` (created **disabled**, default config, no identity secret). `DELETE` is soft -> `204`. Responses never include `identity_secret`. |
| `PUT /widgets/{ulid}/draft` | `{ config }`, validated strictly (unknown keys, ranges, colours, URLs -> `422`, details under `config.*`). Returns `200 { data: WidgetData }` (`has_unpublished_changes` shows the difference). Does not affect visitors. |
| `POST /widgets/{ulid}/publish` | Copies draft -> published, writes the mirrored columns, bumps `config_version`, busts the widget's caches. Returns `WidgetData`. |
| `PUT /widgets/{ulid}/domains` | `{ domains: string[] }` (<= 50) -> `{ data: { domains: [normalised] } }`. Applies immediately. |
| `PUT /widgets/{ulid}/greetings` | `{ greetings: [...] }` (<= 100) -> list envelope of `GreetingData`. Applies immediately. |
| `PUT /widgets/{ulid}/categories` | `{ category_ulids }` (ordered) -> `{ data: { category_ulids } }`. Applies immediately. |
| `POST /widgets/{ulid}/rotate-secret` | `{ data: { identity_secret } }` **once** (`Cache-Control: no-store`); tokens signed with the old secret stop verifying. |
| `GET /widgets/{ulid}/snippet` | `{ script, iframe, hosted, identity_example }` embed codes for the dashboard (placeholders only, never the secret). |

## Chat endpoints (P4) — written ahead of the P4 fan-out

Resource shapes (`Message`, `ConversationPublic`, `ConversationStaff`) are defined in [realtime-events.md](realtime-events.md).

### Public (visitor bearer `vt_…`, `widget` group)

| Method + path | Request | Response |
|---|---|---|
| `POST /public/sessions` | `{ identity_token?, visitor?: {name?,email?,phone?,meta?}, page: {url,title,referrer}, locale }` | `201 { data: { visitorToken, expiresAt, conversation: ConversationPublic \| null, ws: { key, host, port, scheme } } }`. The plaintext token is returned **once**; only its sha256 is stored. A returning token resumes only a still-open conversation. |
| `DELETE /public/sessions` | — | `204` (revokes the token). |
| `GET /public/conversation` | — | `200 { data: ConversationPublic \| null }` (the current session's conversation only — visitors never list history). |
| `POST /public/conversations` | `{ category: slug, name?, email?, phone?, message?, consent?: bool }` (pre-chat rules from widget config are enforced server-side) | `201 { data: ConversationPublic }` queued · `409 no_agents` (offer the offline form) · `409 conversation_exists` · `422`. |
| `POST /public/offline-tickets` | `{ name, email, message, category?, missed_conversation?: ulid }` (the ulid of the visitor's own `missed` live chat, if any; it is recorded in the new row's `created` event) | `201 { data: ConversationPublic }` with `type: 'offline'`, `status: 'queued'`. Offline tickets are separate rows (decision P4-D2); there is no `{ulid}` form because the `409 no_agents` path creates no conversation. Rate limited; needs a visitor token like every public write. |
| `GET /public/conversations/{ulid}/messages` | `?after_seq=&limit=` | `{ data: Message[], meta: { next_cursor } }` ordered by `seq`. |
| `POST /public/conversations/{ulid}/messages` | `{ client_msg_id, body?, attachments?: ulid[] }` (needs body or attachment) | `201 { data: Message }` (replay of the same `client_msg_id` → `200` original). |
| `POST /public/conversations/{ulid}/attachments` | multipart `file` (jpeg/png/webp/gif, ≤ 5 MB default, ≤ 4096 px; mime sniffed with `finfo`, EXIF stripped by re-encode, SVG rejected) | `201 { data: { ulid, mime, size, width, height, url, thumbUrl } }`; referenced from the next message. |
| `POST /public/conversations/{ulid}/receipts` | `{ delivered_upto?, seen_upto? }` | `204`. |
| `POST /public/conversations/{ulid}/typing` | `{ typing: bool }` | `204` (fallback when whispers are unavailable). |
| `POST /public/conversations/{ulid}/end` | — | `200 { data: ConversationPublic }` (`ended`, `ratingRequested: true`). |
| `POST /public/conversations/{ulid}/rating` | `{ score: 1..5, comment? (≤ 2000) }` | `201`; conversation becomes `closed`. One rating per conversation. |
| `POST /public/broadcasting/auth` | Pusher form `socket_id`, `channel_name` | Pusher auth JSON (visitor channels only). |
| `GET /public/attachments/{ulid}` | signed URL | `302` to a short-lived storage URL. |

A visitor token is bound to **one** visitor session and at most one open conversation; every `{ulid}` is checked against it (cross-visitor access = `404`, not `403`).

### Management (Sanctum)

| Method + path | Notes |
|---|---|
| `GET /conversations` | filters `status, category, widget, agent, type, q (FULLTEXT), from, to`, cursor paging. Agents are scoped server-side by `Conversation::visibleTo` (assigned to them, open offers while queued, queued offline tickets in a category they serve; admins see all). WhatsApp chats are **not** conversations and never appear here. |
| `GET /conversations/queue` | queued chats currently offered to the caller (agent) or all (admin). |
| `GET /conversations/{ulid}` · `GET …/messages?after_seq=` | policy: admin, or assigned agent, or offered-while-queued. |
| `POST /conversations/{ulid}/claim` | atomic accept → `200 ConversationStaff` or `409 already_claimed`. Also requires category eligibility and `active_chats < max_concurrent_chats`. |
| `POST …/messages` · `POST …/attachments` · `POST …/receipts` · `POST …/typing` | same shapes as public, authored as the agent. |
| `POST …/end` | agent/admin ends the chat (`ratingRequested: true`). |
| `POST …/close` | agent/admin closes an **offline ticket** (answered) or an admin closes any open chat: result `closed`, reason `system`; no rating prompt. Offline tickets: `queued -> active (claim) -> closed`. |
| `POST …/reply-email` | not an endpoint: staff reply to an offline ticket with the normal `POST …/messages`; for `type=offline` the stored message is also e-mailed (queued mailable) to the visitor's address. |
| `POST …/transfer` | `{ agent_id } \| { category }` → re-queued with assignee cleared, history kept in `conversation_events`. |
| `GET /conversations/export` | admin only; streamed CSV/JSON, queued for large ranges. |
| `GET /me/presence` · `PUT /me/presence {status}` · `POST /me/presence/heartbeat` | status `online\|away\|offline`; heartbeat every 30 s. |
