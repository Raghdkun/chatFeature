# REST conventions and shapes

> Status: contract v1 (written before P3). P3 implements the widget endpoints; P4 extends this file (sessions, conversations,
> messages) **before** its fan-out. Full endpoint inventory: [../rest-api.md](../rest-api.md).

## Conventions (all APIs)

- Base: management `/api/v1/*` (Sanctum, cookie for the dashboard / bearer for mobile); public visitor API `/api/v1/public/*`
  (bearer visitor token, `widget` middleware group — **no cookies, no CSRF, never stateful**); webhooks `/webhooks/*`.
- Success: `{ "data": <resource> }`; lists: `{ "data": [...], "meta": { "next_cursor": "…" | null } }` (cursor pagination, `?cursor=&limit=`).
- Errors: `{ "error": { "code": "snake_case", "message": "Human readable", "details"?: { field: ["msg"] } } }` with HTTP status
  `400/401/403/404/409/422/429/503`. Validation errors use `422` and `details` keyed by field.
- Public identifiers only: `ulid` (conversations, messages, attachments, visitors) and `public_key` (`wk_…`, widgets).
- Timestamps ISO-8601 UTC with milliseconds (`2026-09-30T12:00:00.000Z`). Message ordering is by `seq` (integer, per conversation).
- Idempotency: write endpoints that create messages accept `client_msg_id` (ULID, client generated) — replays return the original resource with `200`.
- Rate limits: named limiters (`public-session`, `public-message`, `public-upload`, `auth-login`, `api`, `wa-webhook`); `429` includes `Retry-After`.
- Versioning: path (`/v1`). Additive changes only; breaking changes ship as `/v2`.
- Resources are Laravel `JsonResource`s backed by `spatie/laravel-data` classes with `#[TypeScript]` where the dashboard/loader consume them.

## Public widget endpoints (P3)

### `GET /api/v1/public/widgets/{key}/config?locale=xx`

- `200 { "data": ResolvedBootConfig }` (see [widget-config.md](widget-config.md)), `ETag` + `Cache-Control: public, max-age=60, stale-while-revalidate=300`,
  `Vary: Origin`, `Access-Control-Allow-Origin: <origin>` **only** when the request `Origin` matches `widget_domains`.
- `404 widget_not_found` (unknown key or disabled widget); `403 origin_not_allowed` (browser `Origin` not whitelisted; no ACAO header).
- Requests without an `Origin` header (server-to-server, mobile) are allowed only when the widget has `allow_non_browser_clients = true`.

### `GET /api/v1/public/widgets/{key}/availability`

`200 { "data": { "online": bool, "openNow": bool, "nextOpenAt": "ISO"|null, "categories": [ { "slug": "billing", "online": true } ], "whatsapp": { "enabled": bool } } }`
Cached in Redis for 5–10 s; same origin rules as `config`.

### Loader delivery

`GET /w/{key}.js` (web route, not under `/api`): the loader bundle + inlined `ResolvedBootConfig`, `ETag`, `Cache-Control: public, max-age=60, stale-while-revalidate=300`.
`GET /widget/v1/loader.js` is the generic loader (reads `data-widget-key` and fetches `config`).

### Iframe page

`GET /embed/{key}[?mode=inline&preview=1]` (web route): Blade shell for the React panel, `Content-Security-Policy: frame-ancestors <widget_domains>`
(preview: `frame-ancestors 'self'`), `X-Content-Type-Options: nosniff`, no cookies set. Hosted page `GET /c/{key}` sends `frame-ancestors 'none'`.

## Management endpoints used by P3 (admin only unless noted)

| Method + path | Notes |
|---|---|
| `GET/POST /categories`, `GET/PATCH/DELETE /categories/{ulid}` | Admin CRUD. Delete is soft; rejected with `409 category_in_use` while an active conversation uses it. |
| `GET/PUT /me/categories` | Agent self-selection of served categories (replaces the set). |
| `PATCH /agents/{id}/categories` | Admin assigns categories to an agent (mode-1 and mode-2; role flags come from the auth driver). |
| `GET/POST /widgets`, `GET/PATCH/DELETE /widgets/{ulid}` | Admin CRUD. Responses never include `identity_secret`. |
| `PUT /widgets/{ulid}/draft` | Save `draft_config` (validated). `POST /widgets/{ulid}/publish` copies draft -> published and bumps `config_version`. |
| `PUT /widgets/{ulid}/domains`, `PUT /widgets/{ulid}/greetings`, `PUT /widgets/{ulid}/categories` | Replace sets. |
| `POST /widgets/{ulid}/rotate-secret` | Returns the new `identity_secret` **once**. |
| `GET /widgets/{ulid}/snippet` | `{ script, iframe, hosted }` embed codes for the dashboard. |

## Chat endpoints (P4) — written ahead of the P4 fan-out

Resource shapes (`Message`, `ConversationPublic`, `ConversationStaff`) are defined in [realtime-events.md](realtime-events.md).

### Public (visitor bearer `vt_…`, `widget` group)

| Method + path | Request | Response |
|---|---|---|
| `POST /public/sessions` | `{ identity_token?, visitor?: {name?,email?,phone?,meta?}, page: {url,title,referrer}, locale }` | `201 { data: { visitorToken, expiresAt, conversation: ConversationPublic \| null, ws: { key, host, port, scheme } } }`. The plaintext token is returned **once**; only its sha256 is stored. A returning token resumes only a still-open conversation. |
| `DELETE /public/sessions` | — | `204` (revokes the token). |
| `GET /public/conversation` | — | `200 { data: ConversationPublic \| null }` (the current session's conversation only — visitors never list history). |
| `POST /public/conversations` | `{ category: slug, name?, email?, phone?, message?, consent?: bool }` (pre-chat rules from widget config are enforced server-side) | `201 { data: ConversationPublic }` queued · `409 no_agents` (offer the offline form) · `409 conversation_exists` · `422`. |
| `POST /public/conversations/{ulid}/offline` | `{ name, email, message, category? }` | `201 { data: ConversationPublic }` with `type: 'offline'`. |
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
| `GET /conversations` | filters `status, category, widget, agent, type, q (FULLTEXT), from, to`, cursor paging. Agents are scoped server-side to conversations assigned to them (admins see all). WhatsApp chats are **not** conversations and never appear here. |
| `GET /conversations/queue` | queued chats currently offered to the caller (agent) or all (admin). |
| `GET /conversations/{ulid}` · `GET …/messages?after_seq=` | policy: admin, or assigned agent, or offered-while-queued. |
| `POST /conversations/{ulid}/claim` | atomic accept → `200 ConversationStaff` or `409 already_claimed`. Also requires category eligibility and `active_chats < max_concurrent_chats`. |
| `POST …/messages` · `POST …/attachments` · `POST …/receipts` · `POST …/typing` | same shapes as public, authored as the agent. |
| `POST …/end` | agent/admin ends the chat (`ratingRequested: true`). |
| `POST …/transfer` | `{ agent_id } \| { category }` → re-queued with assignee cleared, history kept in `conversation_events`. |
| `GET /conversations/export` | admin only; streamed CSV/JSON, queued for large ranges. |
| `GET /me/presence` · `PUT /me/presence {status}` · `POST /me/presence/heartbeat` | status `online\|away\|offline`; heartbeat every 30 s. |
