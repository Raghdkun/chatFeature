# REST API

> Status: the P3 endpoints (public widget config/availability; management of categories, agents and widgets) are **implemented and reviewed**; the chat endpoints are P4, hardening and the generated reference (Scribe is installed as a dev dependency; its `/docs` route is removed with `composer install --no-dev`) are P7. Exact shapes and error codes: [contracts/rest-shapes.md](contracts/rest-shapes.md) and [contracts/dashboard-pages-p3.md](contracts/dashboard-pages-p3.md).

Everything lives under a versioned `/api/v1`. One API serves the web dashboard and a future mobile app. Two Scribe configs are planned (management, public). Paths marked "P3" exist today; the rest are **draft** except where marked "plan" (named explicitly in the plan).

## Conventions

| Topic | Rule |
|---|---|
| Versioning | URL-versioned: `/api/v1` |
| Error shape | `{"error":{"code":"...","message":"...","details":{}}}` for every `api/*` response (a 500 in production is `server_error`); the pre-install `503 not_installed` is a bare `{"error":"not_installed"}` |
| Known codes (P3) | `validation_failed` (422), `unauthenticated` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429, `Retry-After`), `widget_not_found` (404) and `origin_not_allowed` (403) on the public widget endpoints, `category_in_use`, `slug_taken`, `managed_by_auth_portal`, `cannot_deactivate_self`, `not_an_agent` (all 409), `auth_unavailable` (503, auth portal down beyond the grace window), `session_revoked` (401), `no_chat_access` (403), `auth_mode_unavailable` (500, `auth.mode` missing on an installed instance), `server_error` (500) |
| Known codes (P4, plan) | `no_agents` (409, start conversation), `already_claimed` (409, claim) |
| Pagination | Cursor pagination (no offsets) |
| Idempotency | `client_msg_id` for messages (unique per conversation); idempotency keys for other writes |
| Rate limiting | Named rate limiters per route group |
| IDs | ULIDs / `public_key` only; no integer ids exposed |

## Public API (widget)

Separate `widget` middleware group: **bearer visitor token only, no cookies, no CSRF**. Origin/CORS rules from [widget-embed-api.md](widget-embed-api.md) apply.

| Area | Endpoint (draft) | Notes |
|---|---|---|
| Widget config (P3) | `GET /public/widgets/{key}/config?locale=` | Published config + greetings + categories + availability, `ETag`/304, origin-checked CORS, rate-limited |
| Availability (P3) | `GET /public/widgets/{key}/availability` | Cached 8 s server side, `max-age=5` |
| Sessions | `POST /public/sessions` | Issues the visitor token (stored hashed) |
| Start conversation | `POST /public/conversations` | `409 no_agents` -> offline form |
| Messages | `GET/POST /public/conversations/{ulid}/messages` | `?after_seq=N` for sync |
| Attachments | `POST .../attachments` | Image only |
| Receipts / typing | `POST .../receipts`, `POST .../typing` | Receipts are batched |
| End / rating | `POST .../end`, `POST .../rating` | |
| WhatsApp hand-off | `POST /public/whatsapp/handoff` (plan) | Returns ticket code + `wa.me` link |
| Broadcast auth | `POST /public/broadcasting/auth` (plan) | Visitor channel auth via bearer token |
| Attachment URLs | signed URLs | Time-limited |

## Management API

Sanctum **stateful cookie** for the dashboard, **bearer** token for mobile. Admin-only groups are marked.

| Area | Endpoint (draft) | Notes |
|---|---|---|
| Auth | `GET /auth/mode` (plan), login, logout, `me` | Login varies by auth mode |
| Me | `/me` (plan): profile, categories, notification settings, presence, push subscriptions, devices | |
| Conversations | list/filter, queue, claim, messages, receipts, end, transfer, export | Claim is atomic ([realtime.md](realtime.md)) |
| Categories, widgets, agents (P3) | `/categories`, `/me/categories`, `/agents`, `/widgets` (+ `draft`, `publish`, `domains`, `greetings`, `categories`, `rotate-secret`, `snippet`) | Admin (listing categories and `/me/categories` for staff) |
| Settings + auth environments | CRUD, test, activate | Admin |
| WhatsApp | sessions, inbox, reply | **Admin only**; agents get 403 ([whatsapp-openwa.md](whatsapp-openwa.md)) |
| Analytics, audit logs | read | Admin |

## Mobile-readiness

- Same endpoints serve the dashboard and the mobile app; only the credential differs (cookie vs bearer).
- In pizzasys mode the mobile app receives **our own Sanctum token** bound to the `external_sessions` row; the pizzasys token never leaves the server. The driver method exists (`attemptForApi`), but no HTTP login route exposes it yet. Staff tokens carry the ability `staff` and expire after `SANCTUM_EXPIRATION_MINUTES` (default 30 days); deactivating an account or removing its chat role deletes its tokens.
- Push: `PushChannel` interface with `WebPushChannel` now; `FcmChannel` stub and a `device_tokens` table prepare for FCM.
- A mobile-readiness review of the API is scheduled in P7 (7B), together with OpenAPI export.
