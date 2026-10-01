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
