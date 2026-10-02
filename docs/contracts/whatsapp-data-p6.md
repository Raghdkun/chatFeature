# WhatsApp data layer (P6 spine)

> Status: implemented foundation for the three P6 tracks (6A backend, 6B UI, 6C mock/ops). Decisions and ownership stay in [whatsapp-p6.md](whatsapp-p6.md); facts about OpenWA in [../whatsapp-openwa.md](../whatsapp-openwa.md) and the full API copy
> [../reference/openwa-api.md](../reference/openwa-api.md). This file says **what exists in code**, under which names, and the rules the tracks write against. The tracks use these names as they are; a change goes through the orchestrator.
> Everything WhatsApp is **admin-only** (P6-D1): no table, model, Data class or channel here is ever shown to an agent; the only visitor-facing shape is `HandoffData`.

## Tables (`database/migrations/2026_11_25_*`)

Statuses, directions and types are plain `string` columns backed by PHP enums (adding a case needs no `ALTER`). Public ids are `ulid`s. Timestamps have second precision (write `now()`, not microseconds).
Columns that hold WhatsApp / OpenWA ids (`wa_chats.chat_id`, `wa_messages.wa_message_id`, `wa_webhook_deliveries.idempotency_key`) are binary-collated on MySQL / MariaDB (`utf8mb4_0900_bin` / `utf8mb4_nopad_bin`): they are identifiers, `AB` and `ab` are different ones.

| Table (model) | Notes |
|---|---|
| `whatsapp_sessions` (`WhatsAppSession`) | `ulid`, `workspace_id` (nullable), `name` 50, `name_key` (virtual: the name while the row is live, NULL once soft-deleted; UNIQUE, so a deleted session frees its name), `openwa_session_id` 64 (UNIQUE, nullable), `openwa_webhook_id` 64 (**added**: `DELETE .../webhooks/{id}` needs it and OpenWA never lists a secret), `engine` 32 (`whatsapp-web.js` default; informational), `status` 16, `phone_e164` 20 (`+` and digits), `push_name` 120, `webhook_secret_encrypted` text, `webhook_registered_at`, `last_qr` text (**encrypted** by the model: a QR is a login credential while it is valid), `last_qr_at`, `ready_at`, `last_error` text, `settings` json (pacing overrides `send_min_interval_ms`, `daily_send_cap`), timestamps, **soft deletes**. Index on `status`. |
| `widgets.whatsapp_session_id` | Nullable FK to `whatsapp_sessions`, `nullOnDelete` (ALTER migration). A soft-deleted session keeps its id here but `Widget::whatsappSession()` resolves to nothing, so the widget behaves as unlinked. |
| `wa_handoff_tickets` (`WaHandoffTicket`) | `ulid`, `widget_id` (cascade), `visitor_id` / `category_id` (nullable, null on delete), `session_id` (cascade), `code` char(8) **UNIQUE** (globally, live or not), `expires_at`, `consumed_at`, `wa_chat_id` (nullable FK, null on delete), timestamps. Indexes `expires_at` (pruning), `(session_id, expires_at)`. |
| `wa_chats` (`WaChat`) | `ulid`, `workspace_id`, `session_id` (cascade), `chat_id` 128 (**UNIQUE with `session_id`**), `phone_e164`, `push_name`, `is_group`, `status` (`open` / `archived`), `widget_id` / `visitor_id` / `category_id` (nullable, null on delete: the recorded chat stays), `handoff_ticket_id` (nullable FK to the ticket, null on delete; the two tables point at each other, the second FK is added after both exist), `last_inbound_at`, `last_message_at`, `last_message_preview` 160, `unread_by_admin`, `inbound_initiated`, timestamps. Indexes `(status, last_message_at)` (inbox), `(session_id, status, last_message_at)`, `phone_e164`. |
| `wa_messages` (`WaMessage`) | `ulid`, `wa_chat_id` (cascade), `direction` (`in` / `out`), `wa_message_id` 128 (nullable; **UNIQUE with `wa_chat_id`**, NULLs never collide: a `pending` reply has none until OpenWA answers), `type`, `body` text, `media_path` 512 / `media_mime` 100 / `media_filename` 255 / `media_size` bigint, `sent_by_user_id` (nullable, null on delete), `status`, `error` text, `wa_timestamp` (default now), `raw` json, timestamps. Indexes `(wa_chat_id, id)` (transcript), `wa_message_id` (acks carry no chat id). `FULLTEXT(body)` on MySQL / MariaDB only. |
| `wa_webhook_deliveries` (`WaWebhookDelivery`) | `session_id` (cascade), `idempotency_key` 255 (**UNIQUE with `session_id`**), `delivery_id` 64, `event` 48, `outcome` (**nullable**: NULL = accepted, waiting for the queue), `received_at`, `processed_at`, `error` text. No timestamps columns. Index `received_at` (pruning). |

Differences from the contract text: the extra column `openwa_webhook_id`; `name` is unique among **live** sessions (virtual `name_key`) instead of plainly unique, because sessions are soft-deleted (their chats stay readable) and OpenWA lets a deleted name be reused; `wa_webhook_deliveries.outcome` is nullable.
Deleting a session for good (`forceDelete`) cascades to its chats, messages, tickets and deliveries; a soft delete keeps the history and the inbox keeps naming the session.

## Enums (`App\Domain\WhatsApp\Enums`, string-backed, `#[TypeScript]` -> `App.Domain.WhatsApp.Enums.*`)

`SessionStatus` (created, starting, qr, ready, disconnected, failed) · `WaChatStatus` (open, archived) · `WaDirection` (in, out; `isInbound()`) · `WaMessageType` (text, image, video, audio, voice, document, sticker, location, contact, other) ·
`WaMessageStatus` (pending, sent, delivered, read, failed, received) · `WebhookOutcome` (processed, duplicate, rejected, ignored, failed) · `WaRealtimeEvent` (the four broadcast names).

### Session status machine

`SessionStatus::allowedTransitions()` / `canTransitionTo()` (a status never transitions to itself, nothing goes back to `created`):

| From | To |
|---|---|
| `created` | `starting` (start requested), `failed` |
| `starting` | `qr`, `ready` (a paired session needs no scan), `disconnected`, `failed` |
| `qr` | `starting` (QR window ran out, engine re-initialises), `ready`, `disconnected`, `failed` |
| `ready` | `starting` (reconnect), `qr` (unlinked on the phone), `disconnected`, `failed` |
| `disconnected` | `starting`, `qr`, `ready` (automatic reconnect), `failed` |
| `failed` | `starting` (retry), `disconnected` (stopped) |

`isUsable()` = `ready` (the only status in which a reply can be sent and a hand-off number offered); `isRunning()` = starting / qr / ready; `canStart()` = created / disconnected / failed; `canStop()` = `isRunning()`.
**OpenWA is the source of truth.** The table guards the actions an administrator triggers and flags an out-of-order webhook; a reconciliation (a `session.status` webhook, `getSession`) writes the status OpenWA reports through `SessionStatus::fromOpenWa()` even when the move is not in the table (a delivery may have been missed), and only logs it.
OpenWA's wire values differ: `initializing` / `authenticating` -> `starting`, `qr_ready` -> `qr`, `action_required` -> `failed` (our own names are accepted too; unknown -> `null`: keep the status you have).

### Message status

`WaMessageStatus::allowedTransitions()` / `canAdvanceTo()` / `advance($incoming)`: `pending -> sent | delivered | read | failed`, `sent -> delivered | read | failed`, `delivered -> read`; `read`, `failed`, `received` are final (a delivered message cannot fail). Acks arrive late, twice and out of order: store `$current->advance($incoming)`.
`WaMessageStatus::fromOpenWa('delivered')` (the canonical `status` string, `played` = `read`) and `fromAck(int)` (-1 failed, 0 pending, 1 sent, 2 delivered, 3 / 4 read). Every inbound row is `received`. The TypeScript twin (`mergeWaMessages`, `WA_STATUS_TRANSITIONS`) is pinned to the PHP table by a Vitest test.
`WaMessageType::fromOpenWa(?string)` maps OpenWA's `type` tolerantly (`chat` -> text, `ptt` -> voice, `vcard` -> contact, poll / call / revoked / order / product / masked / unknown -> `other`). `isMedia()`; `isStoredAsFile()` is true for `image` only (P6-D7: every other type is a typed row with filename / mime / size and no file).

## Models, relations, helpers (all in `app/Models`, `HasUlids` with `uniqueIds() = ['ulid']`, `#[Fillable]`, written by actions only)

- `WhatsAppSession` (table `whatsapp_sessions`): `widgets()`, `chats()`, `handoffTickets()`, `webhookDeliveries()`; virtual `webhook_secret` (decrypts; null when empty or the app key changed) next to `webhook_secret_encrypted`; `#[Hidden]` for the secret and `last_qr`; `NAME_PATTERN` (OpenWA: letters, digits, hyphens, 3-50);
  `isUsable()`, `canTransitionTo()`, `hasQr()` (status `qr` and an image), `isWebhookRegistered()`, `hasWebhookSecret()`, `webhookUrl()` (the configured app origin, never the request host, + `/webhooks/openwa/{ulid}`), `maskedPhone()` (`+49•••••••6789`), `sendMinIntervalMs()` / `dailySendCap()` (the session's override, else the `whatsapp.*` setting).
- `WaChat`: `session()` (with trashed), `widget()`, `visitor()`, `category()`, `handoffTicket()`, `messages()` (oldest first by id); `isLinked()`, `isArchived()`; scopes `open()`, `forSession(session|id)`, `linked()`, `search($text)` (below). `Widget` gains `whatsappSession()`, `waChats()`, `waHandoffTickets()`; `Visitor` `waChats()`, `waHandoffTickets()`; `Category` `waChats()`; `User` `sentWhatsAppMessages()`.
- `WaMessage`: `chat()`, `sentBy()`; `isInbound()`, `isOutbound()`, `hasStoredMedia()`; `raw` and `media_path` are hidden.
- `WaHandoffTicket`: `widget()`, `visitor()`, `category()`, `session()`, `chat()`; `generateCode(?Closure $taken = null)` (alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, 8 characters, checks the table, ten attempts, then a `RuntimeException`; a creating hook fills `code` when none is given; the UNIQUE index is the real guard, retry on a violation);
  `isLive()` / `isConsumed()` / `isExpired()`; scopes `live()` (not consumed, not expired) and `withCode($typed)` (trims and upper-cases).
- `WaWebhookDelivery`: `session()`, `isProcessed()`, `keyFor($idempotencyKey)` (the key as stored: itself, or `sha256:<hex>` when longer than the column).
- **`WaChat::search()`** (`Support\WaChatSearch`, the twin of P4's `ConversationSearch`): a chat matches by number (a typed number also matches without spaces / dashes / plus), push name, last-message preview, the linked visitor's name / e-mail / phone, or the text of any of its messages (MySQL FULLTEXT boolean mode, SQLite and short words `LIKE`); `%`, `_`, `!` are literal.
- Factories (`database/factories`): `WhatsAppSessionFactory` (default `created`; states `starting()`, `qr()`, `ready($phone)`, `disconnected()`, `failed($error)`, `withWebhook($secret)`, `withPacing($ms, $cap)`; `WhatsAppSessionFactory::FAKE_QR`), `WaChatFactory` (`group()`, `privacyId()`, `archived()`, `unread($n)`, `outboundOnly()`, `linked($widget, $visitor, $category)` which also creates the consumed ticket),
  `WaMessageFactory` (inbound text by default and keeps the chat's `last_message_*` columns in step; `inbound()`, `outbound($admin)`, `pending()`, `delivered()`, `read()`, `failed($error)`, `image($caption)`, `document($filename)`, `voice()`), `WaHandoffTicketFactory` (`forCategory()`, `expired()`, `consumed($chat)`), `WaWebhookDeliveryFactory` (`pending()`, `duplicate()`, `rejected()`, `ignored($event)`, `failed($error)`), and `WidgetFactory::withWhatsAppSession($session)`.

## Domain events (`App\Domain\WhatsApp\Events`)

Plain `final` classes, `Dispatchable` + `SerializesModels`, `ShouldDispatchAfterCommit` (nothing fires from a rolled-back transaction). They carry model references, not payloads.

| Event | Constructor | Dispatched by (6A) | Consumed by |
|---|---|---|---|
| `WaMessageReceived` | `WaMessage $message` (`->chat` is its chat) | the inbound webhook job, after storing the row | broadcasts `wa.message.created` + `wa.chat.updated`; P5 notifications to administrators |
| `WaMessageSent` | `WaMessage $message` | the reply action (stored, handed to OpenWA) | `wa.message.created` + `wa.chat.updated` |
| `WaMessageStatusChanged` | `WaMessage $message, WaMessageStatus $from` | the ack processor (`$message->status` is the new one) | `wa.message.updated` |
| `WaChatLinked` | `WaChat $chat, WaHandoffTicket $ticket` | `ChatLinker` after a code matched | `wa.chat.updated` |
| `WaChatUpdated` | `WaChat $chat` | chat actions (mark read, archive, re-open, name refresh) | `wa.chat.updated` |
| `WaSessionStatusChanged` | `WhatsAppSession $session, ?SessionStatus $from = null` | session actions, the `session.*` webhook processor | `wa.session.status`; the availability cache of the widgets using the session |
| `WaSessionQrUpdated` | `WhatsAppSession $session` | the `session.qr` webhook processor, the QR poll | `wa.session.status` (the payload only says a QR is available) |

## Realtime (decision P6-D8)

- Channel **`private-whatsapp-admin`**, registered in `routes/channels.php` with `App\Domain\WhatsApp\Support\WhatsAppAdminChannel` and the staff guards (`web`, `sanctum`): `StaffAccess::admin()` (an active account with the admin role; a Sanctum bearer's portal session is judged like a browser's) **and** the `private-` kind: `presence-whatsapp-admin`, `whatsapp-admin`, `private-whatsapp-admin.1` and every other spelling are refused, agents never join, visitors never reach the callback (their endpoint refuses it too).
  `WhatsAppRealtime::ADMIN_CHANNEL` (`whatsapp-admin`) and `WhatsAppRealtime::adminChannel()` (a `PrivateChannel`) spell the name once.
- Events (`WaRealtimeEvent` = the `broadcastAs()` names), every payload starts with `v: 1` and is built from a Data class:

| Event | Payload class (`app/Data/WhatsApp/Events`) | Shape |
|---|---|---|
| `wa.message.created` | `WaMessageCreatedPayload` | `{v, message: WaMessageData, chat: WaChatData}` |
| `wa.message.updated` | `WaMessageUpdatedPayload` | `{v, message: WaMessageData}` (ack / failure; **an addition**: the contract lists three events, but ticks need a fourth) |
| `wa.chat.updated` | `WaChatUpdatedPayload` | `{v, chat: WaChatData}` |
| `wa.session.status` | `WaSessionStatusPayload` | `{v, session: WhatsAppSessionData}`; `qrAvailable` / `lastQrAt` say a QR is there, **the image is never broadcast** (fetch it over REST) |

- TypeScript: `resources/js/lib/chat/events.ts` exports `WA_EVENT`, `WaEventName`, `WaEventPayloads`, `waChannels.admin` (`'whatsapp-admin'`, no `private-` prefix) and `waEchoEvent(name)` (leading dot for `broadcastAs` names); `resources/js/lib/whatsapp/types.ts` has short aliases of every generated type;
  `resources/js/lib/whatsapp/messages.ts` has `mergeWaMessages` (idempotent by ulid, forward-only status).

## Data classes (`app/Data/WhatsApp`, generated into `App.Data.WhatsApp.*`, camelCase)

| Class | Audience / use |
|---|---|
| `WhatsAppSessionData::fromModel($session)` | Settings page. `ulid, name, engine, status, phone, maskedPhone, pushName, qrAvailable, lastQrAt, webhookRegistered, webhookUrl, readyAt, lastError, linkedWidgetsCount, isLinkedToWidgets, sendMinIntervalMs, dailySendCap (effective), pacingOverridden, createdAt`. Never the secret, the API key, the OpenWA ids or the QR image. Uses `withCount('widgets')` when loaded. |
| `WaChatData::fromModel($chat)` | Inbox row. `ulid, session{ulid,name}, phone, pushName, isGroup, status, linked, widget{ulid,name}\|null, category{slug,label}\|null, unreadByAdmin, inboundInitiated, lastInboundAt, lastMessageAt, lastMessagePreview, createdAt`. Eager-load `session`, `widget`, `category`. No WhatsApp chat id. |
| `WaChatDetailData::fromModel($chat)` | `{chat: WaChatData, visitor: WaVisitorRefData\|null, handoff: WaHandoffRefData\|null}`; the visitor is `{ulid, name, email, phone, verified}` (no meta, no external id), the ticket `{code, createdAt, consumedAt}`. Also eager-load `visitor`, `handoffTicket`. |
| `WaMessageData::fromModel($message, ?WaMediaUrls)` | Transcript. `ulid, chat (ulid), direction, type, body, media{mime,filename,size,available,url}\|null, status, error (<= 500 chars), sentBy{id,name}\|null, waTimestamp, createdAt`. Eager-load `chat`, `sentBy`. No `wa_message_id`, no `raw`, no storage path. |
| `HandoffData::fromTicket($ticket, ?string $template)` | **Visitor-facing**: exactly `{code, waUrl, expiresAt}`; `waUrl` = `https://wa.me/<digits>?text=<url-encoded handoff text with :code replaced>` (`Support\WaHandoffUrl`), the text from `whatsapp.handoff_text`. Throws `LogicException` for a session without a number. |
| realtime payloads | `WaMessageCreatedPayload`, `WaMessageUpdatedPayload`, `WaChatUpdatedPayload`, `WaSessionStatusPayload` (above). |
| refs | `WaSessionRefData`, `WaVisitorRefData`, `WaHandoffRefData`, `WaMediaData`; `WidgetRefData`, `CategoryRefData`, `StaffAgentRefData` are the P4 ones. |

**`WaMediaUrls`** (`App\Domain\WhatsApp\Contracts`; default `SignedWaMediaUrls`, bound with `bindIf`): temporary signed URLs (60 minutes) for the route **`whatsapp.media.show`** that 6A registers: `GET /api/v1/whatsapp/media/{message}` (`{message}` = the message ulid), middleware `signed`; built on the configured app origin. Without the route generating a URL throws `RouteNotFoundException`.
Tests bind `Tests\Support\FakeWaMediaUrls` (done by `Tests\TestCase`). `WaMediaData.url` is null unless the file is stored.

## Settings (group WhatsApp; seeded on install except the API key and the base URL)

| Key | Type / default | Validation |
|---|---|---|
| `whatsapp.enabled` | bool `false` | |
| `whatsapp.openwa.base_url` | string `http://127.0.0.1:2785` (served by the definition, **not seeded**: a production install may not save a loopback address, and a failing seed step would abort the wizard) | `App\Rules\OpenWaBaseUrl`: plain `scheme://host[:port]` (no credentials, path, query, fragment), canonical address spellings only, judged by `OutboundUrlGuard::checkHost()`: metadata / link-local / multicast / unspecified are refused always, private / loopback / Docker names only when `chat.portal_allow_private_hosts` (`PORTAL_ALLOW_PRIVATE_HOSTS`) or `APP_ENV=local` allows them (**OpenWA on a private network needs that switch**); plain `http` only for a private target, a public host needs `https` |
| `whatsapp.openwa.api_key` | string, none | **encrypted at rest**, `seed: false`, never in `settings()->all()` or any API; nullable, <= 255 |
| `whatsapp.handoff_ttl_minutes` | int `1440` | 5-10080 |
| `whatsapp.ignore_groups` | bool `true` | |
| `whatsapp.reply_only_to_inbound` | bool `true` | |
| `whatsapp.send_min_interval_ms` | int `1500` | 0-60000 (a session may override it) |
| `whatsapp.daily_send_cap` | int `200` | 1-10000 (a session may override it) |
| `whatsapp.handoff_text` | string `Hi! My support code is :code` | `App\Rules\HandoffText`: one line, <= 200 characters, must contain `:code` |
| `whatsapp.media_max_bytes` | int 5 MiB | 10 KiB - 25 MiB |

## OpenWA client (`App\Domain\WhatsApp\Contracts\OpenWaClient`, DTOs and exceptions in `App\Domain\WhatsApp\Support\OpenWa`)

`$sessionId` is always the id OpenWA assigned (`openwa_session_id`), never our ulid.

```php
ping(): OpenWaPing                                   // POST /api/auth/validate: key valid? role, engine
createSession(string $name): OpenWaSession           // POST /api/sessions {name}
startSession(string $sessionId): OpenWaSession       // POST /api/sessions/{id}/start
stopSession(string $sessionId): OpenWaSession        // POST /api/sessions/{id}/stop
deleteSession(string $sessionId): void               // DELETE /api/sessions/{id}   (also removes its webhooks and messages at OpenWA)
getSession(string $sessionId): OpenWaSession         // GET /api/sessions/{id}
getQr(string $sessionId): OpenWaQr                   // GET /api/sessions/{id}/qr  (400 while not waiting for a scan)
registerWebhook(string $sessionId, string $url, string $secret, array $events): OpenWaWebhook   // POST .../webhooks; secret >= 16 chars
deleteWebhook(string $sessionId, string $webhookId): void
sendText(string $sessionId, string $chatId, string $text): OpenWaSendResult                   // 201 = accepted, not delivered
downloadMedia(string $sessionId, string $chatId, string $messageId): ?OpenWaMedia             // null on 404 (nothing stored)
```

`downloadMedia` takes the **chat id too** (the brief had `(sessionId, messageId)`): OpenWA's route is `GET /api/sessions/{id}/messages/{chatId}/{messageId}/media`.
DTOs (readonly, with a tolerant `fromArray()` for what OpenWA sends): `OpenWaSession {id, name, ?SessionStatus status, rawStatus, ?phone (E.164), ?pushName, ?connectedAt, ?lastError, engineLoaded}`, `OpenWaQr {dataUrl, ?status}` (only a base64 **PNG** data URL <= 200 kB is accepted: the value is stored and rendered in an `<img>`),
`OpenWaSendResult {messageId, timestamp}` (epoch seconds), `OpenWaWebhook {id, url, events, active, retryCount}` (never a secret), `OpenWaMedia {contents, mime, ?filename; size()}`, `OpenWaPing {role, engine; canOperate()}`.
Exceptions: `OpenWaUnavailable` (network, timeout, 5xx, an answer that is not what the API documents, or no client configured: transient), `OpenWaRejected {errorCode, status; isNotFound() / isConflict() / isUnauthorized()}` (a 4xx; `OpenWaRejected::fromResponse($status, $body, $retryAfterHeader)` builds it from the NestJS error body, `code` of the body wins, else a slug of the status),
`OpenWaPacingLimited extends OpenWaRejected {retryAfterSeconds}` (`429` with `code: SEND_PACING_LIMITED`; **do not retry before `retryAfterSeconds`**, it can be hours; the global rate limiter's `429` has no `code` and clears in seconds).
Binding: `WhatsAppServiceProvider` registers `NullOpenWaClient` with `bindIf` (every call throws `OpenWaUnavailable`, nothing reaches a network); 6A replaces that line with `bind(OpenWaClient::class, <HTTP client>)`. `Tests\TestCase` binds `Tests\Support\FakeOpenWaClient`, reachable with `WhatsAppFixtures::openWa()`.

`FakeOpenWaClient`: records every call (`calls($method)`, `assertCalled($method, ?Closure $with, ?int $times)`, `assertNotCalled`, `assertNothingCalled`; arguments are named like the method's), and unless a call is scripted behaves like OpenWA: names are 3-50 letters / digits / hyphens and unique (`409`), unknown sessions `404`, start -> `Starting`, stop -> `Disconnected`, `getQr` only while the session is `Qr`
(register one with `withSession($openWa->makeSession($id, SessionStatus::Qr))`), a webhook secret shorter than 16 characters `400`, `sendText` needs 1-4096 characters and answers a unique `true_<chat>_FAKE000001`. Script with `will($method, $valueOrThrowableOrClosure, ?$times = 1)` / `willThrow($method, $exception, ?$times)` (`null` = every call).

## Authorisation (decision P6-D1)

`App\Domain\WhatsApp\Policies\WhatsAppPolicy`, registered for `WaChat`, `WaMessage` and `WhatsAppSession`: **every** ability (`viewAny`, `view`, `reply`, `manageSessions`, `manageSettings`, `archive`, `export`) is true for an active administrator and false for everybody else. `Gate::before` already grants admins everything; the policy says the same on its own, so the policy alone keeps agents out.
State checks (session `ready`, chat started by the customer, pacing caps, group rule) are **not** in the policy: the actions re-check them in guarded code.
`App\Http\Middleware\EnsureWhatsAppAdmin`, alias **`wa.admin`** (`bootstrap/app.php`): use after `auth:sanctum` / `auth`, `session.valid`, `chat.access`; it asks `viewAny` on the policy and answers `403 {error:{code:'forbidden',message}}` as JSON for `api/*` and JSON clients, a normal 403 page otherwise (a missing user, a visitor token included, gets the same).
Webhook and public hand-off routes do **not** use it (they have their own gates: signature, visitor bearer).

| Who | Policy / `wa.admin` | `private-whatsapp-admin` |
|---|---|---|
| active admin (with or without the agent role) | allowed | joins |
| agent | 403 | refused |
| account without a chat role | 403 (`chat.access` answers `no_chat_access` first) | refused |
| deactivated admin / agent | denied (`session.valid` ends the session: 401 in the full stack, 403 on `wa.admin` alone) | refused (401) |
| guest | 401 in the stack (`auth`), 403 on `wa.admin` alone; denied by every ability | refused |
| visitor token (`vt_...`) | 401 in the stack, 403 on `wa.admin` alone | refused on `/broadcasting/auth` and on the visitor endpoint |

## Test support (`tests/Support`)

`FakeOpenWaClient`, `FakeWaMediaUrls` (both bound by `Tests\TestCase`), `WhatsAppFixtures` (`openWa()`, `whatsAppPeople()` = admin, adminAndAgent, agent, inactiveAdmin, inactiveAgent, noRole). Tests never reach a network: an `Http::fake` is needed for any HTTP call, and the null / fake client never makes one.
`ChatSchemaTest::test_the_migrations_roll_back_cleanly_and_run_again` now rolls back every migration from `2026_11_10_000100` on (it used a fixed count of four).

## What each track consumes

- **6A backend**: the migrations / models / factories, `WaHandoffTicket::generateCode()` and `scopeLive` / `withCode` (ChatLinker), `WaWebhookDelivery::keyFor()`, `SessionStatus::fromOpenWa()` / `WaMessageStatus::advance()` / `fromOpenWa()` / `fromAck()` / `WaMessageType::fromOpenWa()`, `PhoneNumber` (`e164`, `fromChatId`, `isGroupChatId`), the events (dispatch them), the Data classes and payloads (build `broadcastAs` classes from them, channel `WhatsAppRealtime::adminChannel()`, names `WaRealtimeEvent`),
  `OpenWaClient` (bind the HTTP implementation, map failures with `OpenWaRejected::fromResponse`), `wa.admin` + `WhatsAppPolicy`, the `whatsapp.*` settings, `WaMediaUrls` (register the route `whatsapp.media.show`), `HandoffData::fromTicket()`, `WaChat::search()`.
- **6B UI**: `App.Data.WhatsApp.*` / `App.Domain.WhatsApp.Enums.*` types through `resources/js/lib/whatsapp/types.ts`, `WA_EVENT` / `waChannels` / `waEchoEvent` in `lib/chat/events.ts`, `mergeWaMessages`, the settings keys. Agents must see nothing: guard nav entries and pages with the admin flag as well as the server's `wa.admin`.
- **6C ops**: `docs/reference/openwa-api.md` shapes; `OpenWaRejected::fromResponse` documents the error body the mock must emit; `FakeOpenWaClient` is the in-process twin of the mock.

## Rules for the tracks

1. **Guarded writes.** Move `whatsapp_sessions.status` and `wa_messages.status` with `UPDATE ... WHERE id = :id AND status = :from` (or an `advance()` check inside a transaction); acks and webhooks repeat and race.
2. **Idempotency.** Insert the `wa_webhook_deliveries` row first (UNIQUE `(session_id, keyFor($key))`): the first insert processes, a repeat is a `200` no-op. OpenWA's key is content-derived and stable across retries; **`X-OpenWA-Delivery-Id` is not a dedupe key** (a replay gets a new one), and the key is always present, so no fallback is needed. The message rows are protected a second time by UNIQUE `(wa_chat_id, wa_message_id)` (this also swallows the `message.sent` echo of a reply the app stored).
3. **Chat ids.** Store one dialect: OpenWA reports `@c.us` (whatsapp-web.js) and `@s.whatsapp.net` (Baileys) for the same person; normalise to `@c.us`, or a changed engine splits one customer into two chats. Only an `individual` `kind` is a chat of a person: `group`, `status` (stories), `channel` and `broadcast` are ignored (`whatsapp.ignore_groups` decides groups), and a `fromMe` message is the phone's own send, not a customer message.
4. **Acks** carry `{id, messageId, status, ack}` and **no chat id**: find the row by `wa_message_id` (indexed) within the session's chats, then `advance()`.
5. **Secrets.** The webhook secret is generated by the app (>= 16 characters, OpenWA never returns it) and lives only in `webhook_secret_encrypted`; the API key only in the encrypted setting. Neither goes into a log, an exception message, an audit entry or a Data class.
6. **Admin-only** is enforced three times: `wa.admin` on routes, `WhatsAppPolicy` in actions, the channel callback. Every new endpoint needs the matrix test (admin, agent, inactive admin, visitor token, guest).
