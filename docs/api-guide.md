# API integration guide

> Status: written in P7 (track 7B). The curl sequences in "Flow 1" and "Flow 2" were **run against a local instance** (Laravel's dev server, MySQL, a real Reverb for the realtime step) and the answers shown are real. "Flow 3" (WhatsApp hand-off) needs a connected WhatsApp session, so it is **derived from the feature tests** (`tests/Feature/WhatsApp/WhatsAppHandoffApiTest.php`), not run.
> This is the short, hand-written guide. The complete reference is generated from the code: [api/openapi-public.yaml](api/openapi-public.yaml) (visitor API) and [api/openapi-management.yaml](api/openapi-management.yaml) (staff API), plus browsable HTML. [rest-api.md](rest-api.md) is the hand-written overview of the decisions behind them.

## 1. Which API, and where the reference lives

| You are building | Use | Credential |
|---|---|---|
| A visitor chat front end (custom web page, native app, kiosk) | the **Public API**, `/api/v1/public/*` | a visitor bearer token `vt_...` from the session call |
| An agent or admin client (a mobile app, a script) | the **Management API**, `/api/v1/*` | a staff bearer token (see [mobile-readiness.md](mobile-readiness.md)) |

Regenerate the reference after changing a route, a Form Request or a Data class (dev dependency Scribe; no server, no secrets, no database needed):

```bash
composer docs:api                     # php artisan docs:api: writes docs/api/openapi-*.yaml (committed) and public/docs/{management,public} (git-ignored HTML)
php artisan docs:api --check          # the CI form: fails when a committed OpenAPI file is out of date
```

The OpenAPI files are what to feed a client generator, Postman, Insomnia or Stoplight. Every example in them is built from the same Data classes the controllers return, every request field from the Form Request rules, every error from the route's middleware. `ApiDocsGuardTest` fails when a route under `api/v1` or `webhooks` is missing from them, and the contract tests (`tests/Feature/Api/*ContractTest.php`) check real responses against their schemas.

## 2. Before you start: who may call the Public API from where

1. **Widget.** Create and publish a widget (dashboard, or `POST /api/v1/widgets`), enable it, add its categories. Its public key `wk_...` (20 lower-case letters and digits) is in the embed snippet.
2. **Origin rules** apply to `config`, `availability` and **session creation**: a browser `Origin` must be on the widget's domain list (`403 origin_not_allowed`); a request **without** `Origin` (a server, a native app) is accepted only when the widget has `allow_non_browser_clients` on (`PATCH /widgets/{ulid} {"allow_non_browser_clients": true}`).
3. **Browsers on other origins cannot call the chat endpoints.** Only `GET config` and `GET availability` send CORS headers. A cross-origin `POST` (session creation, every visitor call) fails at the preflight: it answers `200` with `Allow: POST` and no `Access-Control-*` headers (checked). So a custom **web** front end either runs on the app's own origin (the supplied iframe/hosted page), or proxies the calls through its own backend. Native apps and servers are not browsers: no CORS, but set `allow_non_browser_clients`.
4. **Native websockets must send an `Origin` header.** Reverb refuses a handshake whose `Origin` host is not allowed (`4009 Origin not allowed`), and a client that sends none is refused too (checked). Send `Origin: https://<your app host>` on the websocket upgrade.

## 3. Flow 1: a visitor chat, step by step

`H` is the server, `KEY` the widget key. Every call sends JSON (`Content-Type` and `Accept: application/json`).

```bash
H=https://chat.example.com ; KEY=wk_k3j9x2m5n8p4q7r1s6t0
JSON=(-H 'Content-Type: application/json' -H 'Accept: application/json')

# 1. Config and availability (cacheable: ETag + If-None-Match answers 304). A browser must send its Origin; a native app sends none.
curl -s "$H/api/v1/public/widgets/$KEY/config" "${JSON[@]}" | jq '.data | {locale, categories, preChat: .config.preChat}'
curl -s "$H/api/v1/public/widgets/$KEY/availability" "${JSON[@]}"
# {"data":{"online":true,"openNow":true,"nextOpenAt":null,"categories":[{"slug":"general","online":true}],"whatsapp":{"enabled":false}}}

# 2. A visitor session. Everything is optional. The token is shown ONCE: store it, send it as a bearer from now on.
curl -s -X POST "$H/api/v1/public/widgets/$KEY/sessions" "${JSON[@]}" \
  -d '{"visitor":{"name":"Visitor Vee","email":"vee@example.com"},"page":{"url":"https://example.com/pricing","title":"Pricing"},"locale":"en"}'
# {"data":{"visitorToken":"vt_eVGM...","expiresAt":"2026-11-01T05:22:46.000Z","conversation":null,
#          "ws":{"key":"mhqt9hk53dz8mczkwfup","host":"localhost","port":8315,"scheme":"http"},
#          "limits":{"maxMessageLength":4000,"attachmentMaxBytes":5242880,"attachmentMaxDimension":4096,"attachmentMaxPerMessage":5}}}
VT=vt_eVGM... ; V=("${JSON[@]}" -H "Authorization: Bearer $VT")

# 3. Start the chat. `category` is a slug from the config; name/email follow the widget's pre-chat rules (config.preChat.fields), else 422.
curl -s -X POST "$H/api/v1/public/conversations" "${V[@]}" -d '{"category":"general","message":"Hi, I need help with my invoice"}'
# {"data":{"ulid":"01m3xh2g05mkgsvy3e8e8q1ypj","ticketNo":"X4BWQW","status":"queued","type":"live","category":{"slug":"general","label":"General"},
#          "agent":null,"createdAt":"...","endedAt":null,"ratingRequested":false,"lastSeq":1}}
CV=01m3xh2g05mkgsvy3e8e8q1ypj

# 4. Wait for an agent: poll GET /conversation (or listen for chat.claimed). `status` goes queued -> active (or missed: show the offline form, flow 2).
curl -s "$H/api/v1/public/conversation" "${V[@]}" | jq -c '.data | {status, agent}'

# 5. Send messages. Make up a ULID for client_msg_id: sending the same id again returns the ORIGINAL with 200, so a retry never duplicates.
curl -s -X POST "$H/api/v1/public/conversations/$CV/messages" "${V[@]}" -d '{"client_msg_id":"01j9z3q8x7m5n2k4p6r8t0v1w2","body":"Are you there?"}'
# 201 {"data":{"ulid":"...","seq":3,"conversation":"...","sender":{"type":"visitor","name":"Visitor Vee","avatarUrl":null},"type":"text","body":"Are you there?",
#              "attachments":[],"clientMsgId":"01j9z3q8x7m5n2k4p6r8t0v1w2","createdAt":"...","deliveredAt":null,"seenAt":null}}

# 6. Read: messages after the highest `seq` you hold (ascending, `limit` up to 200; meta.next_cursor is the next after_seq, null at the end).
curl -s "$H/api/v1/public/conversations/$CV/messages?after_seq=0" "${V[@]}" | jq -c '.data[] | {seq, type, body, sender: .sender.type}'

# 7. An image: multipart field `file` (JPEG, PNG, WebP or a still GIF), then reference its ulid in a message. The `url` in the message is a
#    signed URL: fetch it WITHOUT an Authorization header.
curl -s -X POST "$H/api/v1/public/conversations/$CV/attachments" -H "Authorization: Bearer $VT" -H 'Accept: application/json' -F 'file=@photo.png;type=image/png'
curl -s -X POST "$H/api/v1/public/conversations/$CV/messages" "${V[@]}" -d '{"client_msg_id":"01j9z3q8x7m5n2k4p6r8t0v1w5","attachments":["<attachment ulid>"]}'

# 8. Receipts and typing (both 204; batch receipts, send typing at most every 3 s and only while the socket is unavailable).
curl -s -X POST "$H/api/v1/public/conversations/$CV/receipts" "${V[@]}" -d '{"seen_upto":4}'
curl -s -X POST "$H/api/v1/public/conversations/$CV/typing" "${V[@]}" -d '{"typing":true}'

# 9. End and rate. ratingRequested is true; one rating per conversation (a second is 409 already_rated). /rating/skip closes it unrated.
curl -s -X POST "$H/api/v1/public/conversations/$CV/end" "${V[@]}"
curl -s -X POST "$H/api/v1/public/conversations/$CV/rating" "${V[@]}" -d '{"score":5,"comment":"Quick and helpful"}'

# 10. Leave: revokes every session of the visitor (a chat still waiting is cancelled with it). 204.
curl -s -X DELETE "$H/api/v1/public/sessions" "${V[@]}"
```

Notes that matter in practice:

- **Resuming.** Keep the token (host storage, never a cookie or a URL). On the next visit call `POST .../sessions` again with `Authorization: Bearer <old token>`: the visitor stays the same, a **new** token comes back, the old one lives 60 more seconds, and a still-open chat moves to the new session and is returned in `conversation`. A token that expired is `401 session_revoked`: create a new session.
- **One open live chat per visitor** (`409 conversation_exists`). A visitor never lists history; `GET /conversation` is their latest live chat in any status, which is how a `missed` or `closed` outcome is learned when no realtime event arrived.
- **Status machine.** `queued` to `active` (an agent accepted), `ended` (rating window open) to `closed`; or `queued` to `missed` / `closed` (cancelled). Only an `active` chat takes messages, typing and attachments (`409 conversation_not_active`).
- **Signed identity.** To mark a visitor verified, send an HS256 JWT minted by **your backend** as `identity_token` in step 2; see [widget-embed-api.md](widget-embed-api.md) for the claims. It must still be valid when the session is created (default lifetime 5 minutes).

## 4. Flow 2: nobody is available, so an offline ticket

When `availability.online` is false, or `POST /conversations` answers `409 no_agents`, or a chat turns `missed`, offer the offline form:

```bash
curl -s -X POST "$H/api/v1/public/conversations" "${V[@]}" -d '{"category":"general","name":"Vee","email":"vee@example.com"}'
# 409 {"error":{"code":"no_agents","message":"No agent is available right now."}}
curl -s -X POST "$H/api/v1/public/offline-tickets" "${V[@]}" \
  -d '{"name":"Visitor Vee","email":"vee@example.com","message":"Nobody was online, please call me back.","category":"general"}'
# 201 {"data":{"ulid":"...","ticketNo":"GMXTR9","status":"queued","type":"offline","category":{"slug":"general","label":"General"},...}}
```

Order of checks on start: validation (`422`, including the pre-chat rules) comes before availability (`409 no_agents`). Pass `missed_conversation` (the ulid of the visitor's missed chat) to link the ticket to it. Staff answer a ticket with the normal message endpoint and the reply is e-mailed. Rate limited per session (3 a minute).

## 5. Flow 3: continue in WhatsApp (derived from the tests, not run)

Needs the widget's `features.whatsapp` on and a connected WhatsApp session linked to it (admin setup). Visitor bearer plus the widget gate (`Origin` rules):

```bash
curl -s -X POST "$H/api/v1/public/widgets/$KEY/whatsapp-handoff" "${V[@]}" -d '{"category":"billing"}'
# 201 {"data":{"code":"K7M2Q9XA","waUrl":"https://wa.me/4915123456789?text=Hi%21%20My%20support%20code%20is%20K7M2Q9XA","expiresAt":"...","ttlSeconds":86400}}
```

Open `waUrl` (it types the code into WhatsApp). When the visitor sends it, the chat is linked to their widget visitor. The same live code comes back with `200` while it lives (one per visitor and topic); count down with `ttlSeconds` from your arrival time, not from `expiresAt`. Errors: `403 feature_disabled`, `409 whatsapp_unavailable`, `404 widget_not_found` (also when `{key}` is not the token's widget), `429` with `Retry-After`.

## 6. Realtime (Reverb, Pusher protocol)

Realtime is an add-on: **every event also exists as a REST read**, so a client without a socket polls (`GET .../messages?after_seq=N` every 3 to 5 s, `GET /conversation` for status). Do not open a socket before the visitor starts a chat.

```js
import Pusher from 'pusher-js';

const { ws } = session.data;                       // from the session answer; null = no realtime, stay on REST
const pusher = new Pusher(ws.key, {
  cluster: 'mt1',                                  // required by the library, ignored by Reverb
  wsHost: ws.host, wsPort: ws.port, wssPort: ws.port,
  forceTLS: ws.scheme === 'https', enabledTransports: ['ws', 'wss'],
  channelAuthorization: {
    endpoint: `${H}/api/v1/public/broadcasting/auth`,           // not /broadcasting/auth: that one is for staff
    transport: 'ajax',
    headers: { Authorization: `Bearer ${visitorToken}` },
  },
});

const channel = pusher.subscribe(`private-conversation.${conversationUlid}`);   // the ulid in lower case; nothing else is signed
channel.bind('message.created', ({ message }) => { /* merge by ulid/seq */ });
channel.bind('chat.claimed',    ({ agent }) => { /* agent.name, agent.avatarUrl */ });
channel.bind('conversation.ended', ({ endedBy, ratingRequested }) => { /* show the rating prompt */ });
channel.bind('typing',          ({ actor, typing }) => { /* untrusted: expire after 5 s */ });
channel.bind('client-typing',   ({ actor, typing }) => { /* the whisper: same handler */ });
```

The event list and payloads are in the Public API introduction and [realtime.md](realtime.md); every payload carries `v: 1`. The channel authorisation answers `403 channel_forbidden` (never `404`) for anything but the session's own conversation channel.

Reconnect rules: keep the highest `seq` per conversation; on every (re)connect, when the app returns to the foreground, or when you see `seq > last + 1`, call `GET .../messages?after_seq=<last>` and merge by `ulid`. Events are never the only source. After a token rotation reconnect with the new token: an already-subscribed socket of the old token keeps receiving until it disconnects.

## 7. Errors and retries

Every error is `{"error":{"code","message","details?"}}`; branch on `code`. The full catalogue is generated into both references.

| Answer | Meaning | What the client does |
|---|---|---|
| `401 unauthenticated` | no or unknown token | create a session |
| `401 session_revoked` | token expired, revoked or rotated away | drop it, create a session, resume with the stored conversation state |
| `404 widget_not_found` | key unknown, widget disabled or deleted | stop; show the offline/static fallback |
| `404 not_found` | not this visitor's conversation (never `403`) | treat as gone |
| `403 origin_not_allowed` | `Origin` not on the list, or no `Origin` and non-browser clients are off | configuration problem, do not retry |
| `409 no_agents` / `conversation_exists` / `already_rated` / `conversation_not_active` ... | expected outcomes | branch: offer the offline form, resume the open chat, update the UI |
| `422 validation_failed` | `details` keyed by field | show per field; `details.identity_token` means re-mint the identity |
| `429 rate_limited` | a limiter said stop | wait `Retry-After` seconds (also set on every 429), then retry; back off exponentially without the header |
| `5xx`, timeouts, network errors | transient | retry with exponential back-off and jitter. A **message** retry is safe because of `client_msg_id`; a retry of anything else that may have succeeded (start chat) first re-reads state (`GET /conversation`) |
| `503 realtime_unavailable` | Reverb is not configured | stay on REST polling |

Time out requests at 20 s (uploads 90 s), as the panel does. `204` and `304` have no body.

## 8. Rate limits (per minute, defaults)

Per visitor session: 240 calls, **30 message sends**, 10 uploads, 3 offline tickets; per client network: 600 visitor calls (counted before the token is looked up), 60 session creations (30 per widget key), 600 config reads; starting chats is limited per widget and network (3) and per widget (120), plus a 10 second cool-down after cancelling a waiting chat. The numbers are generated from `config/chat.php` into the references; staff calls are 600 a minute per user. Throttled routes also send `X-RateLimit-Limit` / `X-RateLimit-Remaining`.

## 9. Versioning and compatibility

The version is in the path (`/api/v1`). Within `/v1` changes are **additive** (new fields, new optional parameters, new endpoints, new error codes): clients must ignore unknown fields and treat an unknown `error.code` by its HTTP status. A breaking change ships as `/api/v2` (the overlap with `/v1` will be announced with it); the OpenAPI `info.version` is `v1`. Nothing is deprecated today; a deprecation will be announced in `docs/changelog.md` and marked `deprecated` in the OpenAPI file (the API sends no `Deprecation`/`Sunset` headers yet).

Naming: the P3 admin resources (widgets, categories, agents, the auth user) use snake_case fields; the chat, notification, WhatsApp and auth-token resources use camelCase. Requests are snake_case everywhere.

## 10. Security notes for integrators

- The visitor token is a bearer secret. Send it only in `Authorization`, never in a URL or query string (logs and referrers leak them), never in a cookie; keep it out of analytics and crash reports. The server stores only its sha256.
- Signed attachment URLs are credentials too: do not log them and do not add an `Authorization` header when fetching them. They live `chat.attachment_url_ttl_minutes` (240); request fresh ones by re-reading the messages instead of persisting them.
- Mint identity tokens (`identity_token`) on your **server** with the widget's identity secret; never in browser code. Rotating the secret invalidates old tokens at once.
- Do not trust what arrives on the channel: typing events and message bodies are untrusted input (plain text, never HTML; render it escaped).
- The Origin check is a browser control, not authentication: a non-browser client can send any `Origin`. That is why anti-automation limits (per-network and per-widget budgets, the cancel cool-down) exist; put your own captcha in front of session creation if you expose it to the open internet.
- Pin TLS to your own certificate or its issuer in native apps only if you control rotation; the API itself needs no client certificates.

## 11. Staff clients (agent apps)

Everything the dashboard does is in the Management API, with the same endpoints for cookie and bearer. There is no password-login endpoint yet; read [mobile-readiness.md](mobile-readiness.md) for the verdict on each thing a native agent app needs (auth in both modes, inbox, presence heartbeats of a backgrounded app, push, realtime with a bearer, deep links, gaps and estimates).
