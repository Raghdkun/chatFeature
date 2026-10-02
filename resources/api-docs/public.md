The Public API is what a visitor's chat client talks to: the widget's own panel, a custom web front end or a native app. It lives under `/api/v1/public`, speaks JSON, uses **no cookies and no CSRF** and is never stateful. Staff use the [Management API](../management/index.html).

## Authentication and origin rules

| Call | Credential |
|---|---|
| `GET /widgets/{key}/config`, `GET /widgets/{key}/availability`, `POST /widgets/{key}/sessions` | None. They pass the **widget gate**: unknown, deleted or disabled key `404 widget_not_found`; a browser `Origin` that is not on the widget's domain list `403 origin_not_allowed`; a request **without** `Origin` (a server or a native app) only when the widget's `allow_non_browser_clients` is on (or the browser says `Sec-Fetch-Site: same-origin`). |
| Everything else | `Authorization: Bearer vt_...`, the visitor token from the session call. It is bound to **one** visitor session and widget: `401 unauthenticated` for an unknown token, `401 session_revoked` for an expired, revoked or rotated-away one, `404 widget_not_found` once the widget was disabled or deleted. Every `{ulid}` is checked against the session: another visitor's conversation is `404`, never `403`. |
| Attachment downloads | A signed URL (no `Authorization` header). |

Treat the token as a secret: send it only in the `Authorization` header, never in a URL or log it. It lives `chat.visitor_session_ttl_days` (30 by default) and is rotated by calling the session endpoint again with the old token.

## CORS: who can call what from a browser

Only the two `GET` calls of the widget gate (`config`, `availability`) send CORS headers, and only for origins on the widget's domain list (plus this installation's own origin): `Access-Control-Allow-Origin` echoes the origin, `OPTIONS` preflights are answered with `204`. **Session creation and every visitor call carry no CORS support**: the preflight of a cross-origin `POST` (or of any call with an `Authorization` header) is not answered, so a web page on another origin cannot call them. Use one of: the supplied widget (an iframe served from this origin, so same-origin), a backend of yours that proxies the calls, or a native client (no CORS applies; the widget needs `allow_non_browser_clients`).

## Conventions

- **Envelope.** Success: `{ "data": <resource> }`; lists: `{ "data": [...], "meta": { "next_cursor": ... } }`. Message lists page by `seq` (`after_seq`, `limit`); `next_cursor` is the `after_seq` of the next page.
- **Resources** are camelCase and visitor-safe: agents appear as `{ name, avatarUrl }`, never an id or e-mail address; there are no integer ids anywhere.
- **Timestamps** are ISO-8601 UTC with milliseconds. Never compare `expiresAt` with the visitor's own clock: use `ttlSeconds` where given, or count from arrival time.
- **Idempotency.** Send `client_msg_id` (a client-made ULID) with every message: a repeat returns the original with `200`, so a retry after a timeout never duplicates.
- **Versioning.** The version is in the path. Changes inside `/api/v1` are additive and clients must ignore unknown fields; a breaking change ships as `/api/v2`.

## Errors

Every `api/*` answer that is not a success is `{ "error": { "code": "snake_case", "message": "...", "details": { ... } } }`. Branch on `code`, never on `message`. `409` answers are expected outcomes the client branches on, not faults.

{{ERROR_TABLE}}

## Rate limits

Per minute, with `429 rate_limited` and `Retry-After` when exceeded. Besides the limits below there are two chat-start guards (a 10 second cool-down after cancelling a queued chat, and at most 3 waiting chats per client network and widget).

{{RATE_LIMITS}}

## Realtime

The panel opens no websocket until the visitor starts a chat. The session answer carries `ws` (`key`, `host`, `port`, `scheme`) when Laravel Reverb is configured; connect with any Pusher-protocol client, authorise `private-conversation.{ulid}` through `POST /broadcasting/auth` of this API, and bind the events below. A realtime outage never fails an HTTP request: with `ws: null` or a dropped socket, poll `GET /conversations/{ulid}/messages?after_seq=N` (and `GET /conversation` for status changes).

| Event (leading dot in Echo) | Payload |
|---|---|
| `message.created` | a visitor-safe `Message` |
| `message.delivered`, `message.seen` | `{ upToSeq, by, at }` |
| `chat.claimed` | the conversation and the agent's `{ name, avatarUrl }` |
| `conversation.ended`, `conversation.closed`, `conversation.transferred` | the state change |
| `typing` and the `client-typing` whisper | `{ actor, typing }`: untrusted input, never stored |

Every payload carries `v: 1`. After any reconnect, resync with `after_seq`; a visitor's socket outlives its token until it disconnects, so the client reconnects with the rotated token.
