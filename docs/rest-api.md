# REST API

> Status: design, implemented in P4 (public + core management) and P7 (hardening); reference docs will be generated with Scribe later (not installed yet).

Everything lives under a versioned `/api/v1`. One API serves the web dashboard and a future mobile app. Two Scribe configs are planned (management, public). Paths below are **draft** except where marked "plan" (named explicitly in the plan).

## Conventions

| Topic | Rule |
|---|---|
| Versioning | URL-versioned: `/api/v1` |
| Error shape | `{"error":{"code":"...","message":"...","details":{}}}` |
| Known codes | `no_agents` (409, start conversation), `already_claimed` (409, claim), `not_installed` (503, before setup), `rate_limited` (429, with `Retry-After`), `slug_taken` (409, category slug taken in the meantime), `not_an_agent` (409, category assignment for an account that does not take chats), `managed_by_auth_portal` (409), `auth_mode_unavailable` (500, `auth.mode` missing on an installed instance) |
| Pagination | Cursor pagination (no offsets) |
| Idempotency | `client_msg_id` for messages (unique per conversation); idempotency keys for other writes |
| Rate limiting | Named rate limiters per route group |
| IDs | ULIDs / `public_key` only; no integer ids exposed |

## Public API (widget)

Separate `widget` middleware group: **bearer visitor token only, no cookies, no CSRF**. Origin/CORS rules from [widget-embed-api.md](widget-embed-api.md) apply.

| Area | Endpoint (draft) | Notes |
|---|---|---|
| Widget config | `GET /public/widgets/{key}/config` | Published config, per-locale strings |
| Availability | `GET /public/widgets/{key}/availability` | Cached 5-10 s |
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
| Categories, widgets, agents | CRUD | Admin |
| Settings + auth environments | CRUD, test, activate | Admin |
| WhatsApp | sessions, inbox, reply | **Admin only**; agents get 403 ([whatsapp-openwa.md](whatsapp-openwa.md)) |
| Analytics, audit logs | read | Admin |

## Mobile-readiness

- Same endpoints serve the dashboard and the mobile app; only the credential differs (cookie vs bearer).
- In pizzasys mode the mobile app receives **our own Sanctum token** bound to the `external_sessions` row; the pizzasys token never leaves the server.
- Push: `PushChannel` interface with `WebPushChannel` now; `FcmChannel` stub and a `device_tokens` table prepare for FCM.
- A mobile-readiness review of the API is scheduled in P7 (7B), together with OpenAPI export.
