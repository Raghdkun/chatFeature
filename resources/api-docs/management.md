The Management API serves the staff dashboard and any other staff client, such as a mobile app. It lives under `/api/v1` and speaks JSON. Everything here is for **signed-in staff** (administrators and agents); visitors use the [Public API](../public/index.html).

## Authentication

Every endpoint needs a credential, in one of two forms:

| Client | Credential | Notes |
|---|---|---|
| The dashboard (same origin) | The Sanctum **session cookie** plus the `X-XSRF-TOKEN` header | CSRF is enforced for cookie calls (`419 csrf_mismatch`). Background calls only read the session and never extend it. |
| A mobile app or script | A **bearer token** in the `Authorization` header | One token per signed-in device, ability `staff`. No cookies, no CSRF. |

Send `Authorization: Bearer <token>`, where the token is the string `<id>|<secret>` issued at sign-in. Bearer tokens are Laravel Sanctum personal access tokens. They are stored hashed (the string is shown once, at sign-in), they **do not slide**: each one stops working after `SANCTUM_EXPIRATION_MINUTES` (30 days by default), and deactivating an account or removing its last chat role deletes them all. Use `GET /auth/me` to check a stored token, `GET /auth/tokens` to list a user's devices, `DELETE /auth/tokens/{id}` and `POST /auth/logout` to revoke. **There is no password-login endpoint yet** (the driver method exists, no HTTP route exposes it): tokens are issued by the server. See `docs/mobile-readiness.md`.

Two auth modes exist (`mode` in `GET /auth/me`): `fortify` (accounts of this installation) and `pizzasys` (an external auth portal; the portal token never leaves the server, a mobile token is our own Sanctum token bound to the portal session, and `503 auth_unavailable` means the portal cannot be asked right now while the session is kept).

Every request must send `Accept: application/json`. Authentication, session validity and chat access are checked in this order: `401 unauthenticated`, `401 session_revoked` (or `503 auth_unavailable`), `403 no_chat_access`, then the endpoint's own checks (`403 forbidden` for administrator-only routes).

## Conventions

- **Envelope.** Success: `{ "data": <resource> }`. Lists: `{ "data": [...], "meta": { "next_cursor": "..." | null } }`. A list that says it is *complete* always has `next_cursor: null`.
- **Pagination.** Cursor based: pass `meta.next_cursor` as `cursor`, with `limit`. Cursors are opaque. Message lists page by `seq` instead (`after_seq`).
- **Identifiers.** Public ids are ULIDs (lower case). Staff users are identified by their integer id in this staff-only API. Admin resources (widgets, categories, agents) use snake_case field names; chat, notification and WhatsApp resources use camelCase.
- **Timestamps.** ISO-8601 UTC with milliseconds (`2026-09-30T12:00:00.000Z`). Compare `serverTime` of `GET /auth/me` with your clock before counting down any `expiresAt`.
- **Idempotency.** Message creation takes a client-made ULID `client_msg_id`: a repeat returns the original with `200`. Deletes of own rows are idempotent where documented.
- **Versioning.** The version is in the path. Changes inside `/api/v1` are additive (new fields, new endpoints, new optional parameters; clients must ignore what they do not know). A breaking change ships as `/api/v2`. Nothing is deprecated today.
- **CORS.** Not enabled: the dashboard is same-origin and a native app is not a browser.

## Errors

Every `api/*` answer that is not a success is `{ "error": { "code": "snake_case", "message": "...", "details": { ... } } }`. Branch on `code` (and the HTTP status), never on `message`. `details` is keyed by field for `validation_failed` and carries structured values elsewhere (`already_claimed.by`, `no_agents.target`). Before the application is installed every `api/*` call answers `503` with the bare `{ "error": "not_installed" }`.

{{ERROR_TABLE}}

## Rate limits

All limits count per minute; an exhausted one answers `429 rate_limited` with a `Retry-After` header (seconds). Each endpoint lists the limiters in front of it; the numbers below are the defaults (`config/chat.php` `rate_limits` and friends).

{{RATE_LIMITS}}

## Realtime

Live updates use Laravel Reverb (the Pusher protocol); everything also exists as a REST read, so a client without a socket works by polling. Authorise private channels with `POST /broadcasting/auth` (outside `/api`; `application/x-www-form-urlencoded` fields `socket_id` and `channel_name`), sending the same bearer token or session cookie; the answer is the standard Pusher `{ "auth": "key:signature" }`. CSRF does not apply to that route, so a bearer client needs nothing else.

| Channel | Who may join | Carries |
|---|---|---|
| `private-staff.{userId}` | That staff member | chat offers and who took them, unread counters, `session.revoked` |
| `presence-staff` | Any staff member | the roster and `presence.changed` |
| `private-conversation.{ulid}` | Staff who may see the conversation | messages, receipts, typing, claimed, ended, transferred |
| `private-admin` | Administrators | conversation updates, offline tickets, ratings |
| `private-whatsapp-admin` | Administrators | WhatsApp events |

Reconnect rules: keep the highest `seq` per conversation, and after any reconnect, foreground or gap call `GET /conversations/{ulid}/messages?after_seq=N` and `GET /conversations?updated_after=...`. Counters in events are absolute. `session.revoked` means ask REST (`401` confirms) before dropping the session. See `docs/realtime.md` for every event.
