# REST API

> Status: the P3 endpoints (public widget config/availability; management of categories, agents and widgets) are **implemented and reviewed**; the P4 chat endpoints (visitor sessions and chat, staff conversations, presence) are **implemented** (track 4A, see "Chat API (P4)" below; the realtime events they trigger are track 4B), hardening and the generated reference (Scribe is installed as a dev dependency; its `/docs` route is removed with `composer install --no-dev`) are P7. Exact shapes and error codes: [contracts/rest-shapes.md](contracts/rest-shapes.md) and [contracts/dashboard-pages-p3.md](contracts/dashboard-pages-p3.md).

Everything lives under a versioned `/api/v1`. One API serves the web dashboard and a future mobile app. Two Scribe configs are planned (management, public). Paths marked "P3" or listed under "Chat API (P4)" exist today; the rest are **draft** except where marked "plan" (named explicitly in the plan).

## Conventions

| Topic | Rule |
|---|---|
| Versioning | URL-versioned: `/api/v1` |
| Error shape | `{"error":{"code":"...","message":"...","details":{}}}` for every `api/*` response (a 500 in production is `server_error`); the pre-install `503 not_installed` is a bare `{"error":"not_installed"}` |
| Known codes (P3) | `validation_failed` (422), `unauthenticated` (401), `forbidden` (403), `not_found` (404), `rate_limited` (429, `Retry-After`), `widget_not_found` (404) and `origin_not_allowed` (403) on the public widget endpoints, `category_in_use`, `slug_taken`, `managed_by_auth_portal`, `cannot_deactivate_self`, `not_an_agent` (all 409), `auth_unavailable` (503, auth portal down beyond the grace window), `session_revoked` (401), `no_chat_access` (403), `auth_mode_unavailable` (500, `auth.mode` missing on an installed instance), `server_error` (500) |
| Known codes (P4) | `no_agents`, `conversation_exists`, `already_claimed` (`details.by` = the winner's name), `at_capacity`, `conversation_not_active`, `conversation_not_queued`, `conversation_not_ended`, `conversation_not_open`, `already_rated` (all 409, see the chat section), `feature_disabled` (403: the widget switched the feature off) |
| Pagination | Cursor pagination (no offsets) |
| Idempotency | `client_msg_id` for messages (unique per conversation); idempotency keys for other writes |
| Rate limiting | Named rate limiters per route group |
| IDs | ULIDs / `public_key` only; no integer ids exposed |

## Public API (widget)

Separate `widget` middleware group: **bearer visitor token only, no cookies, no CSRF**. Origin/CORS rules from [widget-embed-api.md](widget-embed-api.md) apply.

| Area | Endpoint | Notes |
|---|---|---|
| Widget config (P3) | `GET /public/widgets/{key}/config?locale=` | Published config + greetings + categories + availability, `ETag`/304, origin-checked CORS, rate-limited |
| Availability (P3, P4) | `GET /public/widgets/{key}/availability` | Cached 8 s server side, `max-age=5`; `online` now comes from agent presence (below) |
| Visitor chat (P4) | `POST /public/widgets/{key}/sessions`, `DELETE /public/sessions`, `GET /public/conversation`, `POST /public/conversations`, `POST /public/offline-tickets`, `GET/POST .../messages`, `POST .../attachments`, `.../receipts`, `.../typing`, `.../end`, `.../cancel`, `.../rating`, `.../rating/skip`, `GET /public/attachments/{ulid}` | See "Chat API (P4)" |
| WhatsApp hand-off | `POST /public/whatsapp/handoff` (plan, P6) | Returns ticket code + `wa.me` link |
| Broadcast auth | `POST /public/broadcasting/auth` (track 4B) | Visitor channel auth via bearer token |

## Management API

Sanctum **stateful cookie** for the dashboard, **bearer** token for mobile. Admin-only groups are marked.

| Area | Endpoint (draft) | Notes |
|---|---|---|
| Auth | `GET /auth/mode` (plan), login, logout, `me` | Login varies by auth mode |
| Me | `/me` (plan): profile, categories (P3), notification settings, presence (P4), push subscriptions, devices | |
| Conversations (P4) | `GET /conversations` (+ `/queue`, `/export`, `/{ulid}`, `/{ulid}/messages`), `POST /conversations/{ulid}/{claim,messages,attachments,receipts,typing,end,close,transfer}` | Claim is atomic ([realtime.md](realtime.md)); see "Chat API (P4)" |
| Presence (P4) | `GET/PUT /me/presence`, `POST /me/presence/heartbeat` | Minimal in P4 (database); Redis, auto-away and the sweep arrive in P5 behind the same endpoints |
| Categories, widgets, agents (P3) | `/categories`, `/me/categories`, `/agents`, `/widgets` (+ `draft`, `publish`, `domains`, `greetings`, `categories`, `rotate-secret`, `snippet`) | Admin (listing categories and `/me/categories` for staff) |
| Settings + auth environments | CRUD, test, activate | Admin |
| WhatsApp | sessions, inbox, reply | **Admin only**; agents get 403 ([whatsapp-openwa.md](whatsapp-openwa.md)) |
| Analytics, audit logs | read | Admin |

## Mobile-readiness

- Same endpoints serve the dashboard and the mobile app; only the credential differs (cookie vs bearer).
- In pizzasys mode the mobile app receives **our own Sanctum token** bound to the `external_sessions` row; the pizzasys token never leaves the server. The driver method exists (`attemptForApi`), but no HTTP login route exposes it yet. Staff tokens carry the ability `staff` and expire after `SANCTUM_EXPIRATION_MINUTES` (default 30 days); deactivating an account or removing its chat role deletes its tokens.
- Push: `PushChannel` interface with `WebPushChannel` now; `FcmChannel` stub and a `device_tokens` table prepare for FCM.
- A mobile-readiness review of the API is scheduled in P7 (7B), together with OpenAPI export.

## Chat API (P4)

Resource shapes (`Message`, `ConversationPublic`, `ConversationStaff`, `Attachment`, `Presence`, `Rating`) are the Data classes in `app/Data/Chat` (camelCase JSON, `{ data }` envelope, ISO-8601 UTC timestamps with milliseconds), listed in [contracts/realtime-events.md](contracts/realtime-events.md) and [contracts/chat-data-p4.md](contracts/chat-data-p4.md). Request fields are snake_case. Every error uses the envelope `{ error: { code, message, details? } }`; `409` conflicts are expected outcomes the clients branch on, not faults.

### Visitor side (`/api/v1/public`, bearer `vt_...`, no cookies, no CSRF)

`POST /public/widgets/{key}/sessions` goes through the P3 gate (unknown or disabled widget `404 widget_not_found`, browser `Origin` not whitelisted `403 origin_not_allowed`, network limits) plus the `public-session` limiter. **Every other call** sends only `Authorization: Bearer vt_...` (the `visitor` middleware: `401 unauthenticated` for an unknown token, `401 session_revoked` for a revoked or expired one) and answers `404 widget_not_found` once its widget was disabled or deleted. Every `{ulid}` must belong to the token's session: **another visitor's conversation is `404 not_found`, never `403`**. A visitor never lists history: `GET /public/conversation` is the session's own latest live chat.

| Endpoint | Request | Success | Errors |
|---|---|---|---|
| `POST /public/widgets/{key}/sessions` | `{ identity_token?, visitor?: {name?, email?, phone?, meta?}, page?: {url, title, referrer}, locale? }` (all optional) | `201 { visitorToken, expiresAt, conversation: ConversationPublic \| null, ws: {key, host, port, scheme} \| null }`, `Cache-Control: no-store`. The plaintext token is shown **once**, only its sha256 is stored. `ws` is `null` when Reverb is not configured: the panel stays on REST. | `422` (`details.identity_token` when a signed identity does not verify: it is refused, never downgraded to anonymous), `429` |
| `DELETE /public/sessions` | | `204`. Revokes the token; a chat still `queued` is cancelled with it, an active one stays (the idle timer closes it). | |
| `GET /public/conversation` | | `200 { data: ConversationPublic \| null }`: this session's latest live conversation in **any** status (so a `missed` or `closed` outcome is readable when no realtime event arrived); offline tickets are never "the conversation" | |
| `POST /public/conversations` | `{ category: slug, name?, email?, phone?, message?, consent? }` | `201 ConversationPublic` (`queued`; the optional `message` is message 1) | `422` (unknown / inactive / not-on-this-widget category in `details.category`; the widget's pre-chat rules: a required enabled field must be present unless the visitor already has it, a disabled field is ignored, a `consentText` needs `consent: true`; nothing is asked with the `preChat` feature off), `409 no_agents` (outside the opening hours, or nobody reachable who serves the category: show the offline form), `409 conversation_exists` (one open live chat per session) |
| `POST /public/offline-tickets` | `{ name, email, message, category?: slug, missed_conversation?: ulid }` | `201 ConversationPublic` (`type: offline`, `status: queued`, no queue timeout). A separate row; the `missed_conversation` (the visitor's own missed live chat) is recorded in the new row's `created` event and gives it its topic when none is sent | `422`, `403 feature_disabled` (offline form switched off), `429` |
| `GET /public/conversations/{ulid}/messages` | `?after_seq=0&limit=100` (max 200) | `200 { data: Message[], meta: { next_cursor } }` ascending by `seq`; `next_cursor` is the `after_seq` of the next page, `null` at the end. Visitor-safe: agents appear as `{type, name, avatarUrl}`, no ids or e-mails | |
| `POST /public/conversations/{ulid}/messages` | `{ client_msg_id?: ulid, body?, attachments?: ulid[] }` (body or attachments; body <= `chat.max_message_length`, <= 5 attachments) | `201 Message`; a repeated `client_msg_id` answers **`200` with the original** (also after the chat ended) | `422`, `409 conversation_not_active` (only an `active` live chat takes messages), `429` (30 a minute per session) |
| `POST /public/conversations/{ulid}/attachments` | multipart `file` | `201 Attachment {ulid, mime, size, width, height, url, thumbUrl}` | `422 validation_failed` with `details.file` (not a jpeg / png / webp / gif by content, over `chat.attachment_max_bytes` or `chat.attachment_max_dimension`, too many pixels for the memory left, markup hidden in the file, 10 uploads already waiting), `403 feature_disabled`, `409 conversation_not_active`, `429` (10 a minute) |
| `POST /public/conversations/{ulid}/receipts` | `{ delivered_upto?, seen_upto? }` (message numbers, one required) | `204` | `422` |
| `POST /public/conversations/{ulid}/typing` | `{ typing: bool }` | `204`. REST fallback of the typing whisper: validated, authorised, then published as the realtime `typing` event (nothing is stored) | `409 conversation_not_active` |
| `POST /public/conversations/{ulid}/end` | | `200 ConversationPublic` (`ended`, `ratingRequested: true`) | `409 conversation_not_active` (also for a queued chat: cancel it), `403 feature_disabled` (`endChatByVisitor` off) |
| `POST /public/conversations/{ulid}/cancel` | | `200 ConversationPublic` (`closed`, reason `cancelled`) | `409 conversation_not_queued` (an agent was first) |
| `POST /public/conversations/{ulid}/rating` | `{ score: 1..5, comment? <= 2000 }` | `201 Rating {conversation, score, comment, createdAt}`; the chat becomes `closed` (`rated`) | `409 conversation_not_ended`, `409 already_rated` |
| `POST /public/conversations/{ulid}/rating/skip` | | `200 ConversationPublic` (`closed`, reason `skipped`) | `409 conversation_not_ended` |
| `GET /public/attachments/{ulid}` | signed URL only (no token), `?thumb=1` for the 320 px thumbnail | `200` image streamed from the private disk (`Content-Type` of the stored file, `nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, neutral file name) | `403` (missing, altered, expired or foreign signature: 30 minutes), `404` |

**Sessions.** A signed identity makes the visitor `verified` and keyed by the token's `sub` (one `Visitor` across browsers; the claims are authoritative, the pre-chat form never overwrites them); unsigned `visitor` data is stored as given and marked unverified. A returning bearer token (an active session of the same widget) is **rotated**: same visitor, a new token, the old one revoked; a previously verified visitor is only continued with a fresh identity proof. Only a still-open live chat (`queued`, `active`) is resumed: it moves to the new session and the session that held it is revoked. Tokens live `chat.visitor_session_ttl_days`.

**Attachments.** Judged by content (`finfo`), never by name or declared type; SVG, HTML, PDF, scripts and polyglots are refused. The image is decoded and encoded again (EXIF, XMP, comments and trailing data do not survive, orientation is applied, an animated GIF keeps its first frame), a 320 px thumbnail is made, files go to the private disk (config `chat.attachments_disk` / env `CHAT_ATTACHMENTS_DISK`, default `local`) under random paths. The client's file name is kept sanitised for staff only. An upload belongs to one conversation and is referenced by one message; unreferenced uploads are deleted after 24 hours.

### Staff side (`/api/v1`, Sanctum cookie or bearer, `session.valid`, `chat.access`; limiter `staff-api`)

Visibility is `Conversation::visibleTo` for lists and `ConversationPolicy` for single conversations (called directly: `Gate::before` would let an admin through every state check). A conversation the caller may not see is `403 forbidden`. WhatsApp chats are not conversations and never appear.

| Endpoint | Notes |
|---|---|
| `GET /conversations` | Filters `status` (comma-separated), `category` (ulid or slug), `widget` (ulid), `agent` (user id or `me`), `type`, `q`, `from`, `to` (creation time), `updated_after`; `limit` (default 25, max 100) and the opaque `cursor`; newest first. `{ data: ConversationStaff[], meta: { next_cursor } }`. `q` matches a ticket number exactly, or message text: MySQL / MariaDB FULLTEXT (boolean mode, every word a prefix), `LIKE` on SQLite and for words under 3 characters. |
| `GET /conversations/queue` | Queued chats the caller can accept (their open offers, offline tickets of their categories; everything for an admin), oldest first, at most 200. |
| `GET /conversations/{ulid}` · `GET .../messages?after_seq=&limit=` | `ConversationStaff`; messages with the sender's staff id. |
| `POST /conversations/{ulid}/claim` | The atomic accept, `200 ConversationStaff`. `409 already_claimed` (`error.details.by` = the winner's name; for an agent who was offered the chat), `409 conversation_not_queued` (gone: cancelled, missed, closed), `409 at_capacity` (live chats >= `max_concurrent_chats`; offline tickets take no slot), `403` (not an active agent, no open offer, does not serve the category; admins who take chats may claim any queued chat). |
| `POST .../messages` · `POST .../attachments` | Same shapes as the visitor's. Only the assigned agent or an admin; the chat must be `active` (`409 conversation_not_active`). A reply on an **offline ticket** is also e-mailed (queued `OfflineTicketReply`) to the visitor's address. |
| `POST .../receipts` · `POST .../typing` | Only the assigned agent (an admin looking in does not mark a chat read). `204`; typing is published as the realtime `typing` event. |
| `POST .../end` | Assigned agent or admin; `ended` (`ended_by` agent or admin) and the rating prompt. `409 conversation_not_active` for anything but an active live chat. |
| `POST .../close` | An agent resolves their claimed **offline** ticket; an admin closes any unfinished conversation (queued, active, ended): `closed`, reason `system`, no rating prompt. `409 conversation_not_open`. |
| `POST .../transfer` | `{ agent_id }` or `{ category }` (ulid or slug) on an active chat: it returns to `queued` with the assignee cleared and the history kept in `conversation_events`. A category goes through the routing waves (the agent who let go is not offered it again); an agent (active, `is_agent`, serves the chat's category) is the only one offered it and accepts it like any offer. `422` for a bad target, `409 conversation_not_active`. |
| `GET /conversations/export?format=csv\|json` | **Admin only**, same filters, streamed in chunks of 500 (flat memory), `Content-Disposition: attachment`; CSV cells that start with `=`, `+`, `-`, `@` are prefixed with a quote; recorded in the audit log (`conversations.exported`). |
| `GET /me/presence` · `PUT /me/presence {status: online\|away\|offline}` · `POST /me/presence/heartbeat` | Any staff member. `GET` / `PUT` return `{ userId, status, isManual, lastSeenAt }` with the **effective** status. Clients beat every 30 s. |

**Presence and routing.** An agent is reachable when the account is active and `is_agent`, the stored status is `online` or `away` with a heartbeat younger than **90 s**, they serve the category and have fewer active live chats than `max_concurrent_chats`. The same rule feeds `availability.online` (and each category's `online`) of the public availability endpoint, which also needs the widget to be open; the cached answer is dropped when an agent starts or stops being reachable. Routing waves come from the widget's `routing.waves` (default: `online` agents at once, `away` agents after `chat.offer_wave_delay_seconds` = 20 s); each wave offers the chat to every reachable agent of the statuses so far who has no offer yet. `queue_expires_at = queued_at + widget.queue_timeout_seconds` (default 90 s), after which the chat is `missed`.

### Rate limits (per minute, `config/chat.php` `rate_limits`)

| Limiter | Applies to | Default |
|---|---|---|
| `public-session` | session creation: per client network / per network + widget key | 60 / 30 |
| `public-message` | visitor calls: per session 240 (reads, receipts, typing, end, rating, ...), **30 for message sends**, per client network 600; signed attachment downloads count against the network | |
| `public-upload` | image uploads per session (and the network ceiling) | 10 |
| `public-offline` | offline tickets per session / per client network | 3 / 10 |
| `staff-api` | management chat calls per staff member | 600 |

`429 rate_limited` carries `Retry-After`.

### Scheduled timers (`routes/console.php`; needs `schedule:run` every minute and a queue worker)

| Command | Schedule | Effect |
|---|---|---|
| `chat:expire-queued` | every minute | Queued live chats past `queue_expires_at` become `missed` (a delayed `ExpireQueuedConversation` job does the same per chat; this is the safety net). Offers are expired. |
| `chat:close-idle` | every minute | Active chats past `idle_expires_at` (messages move it; typing and presence do not) become `closed` (`idle`), no rating prompt, chunks of 500. Offline tickets never idle. |
| `chat:close-unrated` | every minute | `ended` chats past `rating_window_expires_at` (`chat.rating_window_minutes`, default 10) become `closed` (`timeout`). |
| `chat:prune-visitor-sessions` | daily 03:45 | Deletes sessions expired or revoked more than 7 days ago (their chats stay), anonymous visitors left with neither a session nor a chat, and uploads no message referenced for 24 hours (`--session-days`, `--attachment-hours`). |

Each sweep is a guarded `UPDATE ... WHERE status = :from AND <deadline>`, so a missed minute only delays a transition and two schedulers cannot move a chat twice.
