# Widget embed API

> Status: loader, boot config, domain whitelist, identity verifier and the JS API are **implemented in P3**; the chat panel inside the iframe (`resources/js/embed`, entry `main.tsx`) and the visitor API it talks to are **implemented in P4**, so the handshake below runs against the real panel.
> Normative details: [contracts/widget-config.md](contracts/widget-config.md) (config, precedence, boot trust, identity claims) and [contracts/postmessage-protocol.md](contracts/postmessage-protocol.md) (host <-> iframe messages). This page is the integrator's overview.

## Architecture in one paragraph

A tiny vanilla-TS IIFE loader (budget **<= 16 KB gz**, enforced by `npm run size`; the current build is about 15.8 KB) mounts the launcher and greeting popup in an open **Shadow DOM**. The chat panel is a React **iframe** at `/embed/{publicKey}`. This gives CSS isolation both ways, keeps host JS/XSS away from the chat and token, and the host CSP only needs `script-src` + `frame-src` (plus `connect-src` when the config is fetched instead of inlined, `img-src` for avatars/icons and `style-src`/`font-src` for a custom `fontUrl`). There are **no cookies**: the visitor token lives in host-origin `localStorage` and is passed to the iframe by `postMessage`, so Safari ITP / partitioned storage cannot break it.

## Embed variants

| Variant | Use |
|---|---|
| Script snippet `/w/{key}.js` | Boot config inlined, ETag-cached. Primary embed. |
| Generic `loader.js` + `data-widget-key` | One script, key passed as an attribute; fetches `/api/v1/public/widgets/{key}/config` |
| Inline iframe embed `/embed/{key}?mode=inline` | Chat panel inside a page region |
| Hosted page `/c/{key}` | Standalone page (`frame-ancestors 'none'`); WhatsApp links/QR later |

The dashboard's Embed tab shows the exact snippets (`GET /api/v1/widgets/{ulid}/snippet`). Public keys look like `wk_` + 20 lower-case letters/digits.

```html
<script async src="https://chat.example.com/w/wk_xxxxxxxxxxxxxxxxxxxx.js" data-position="left"></script>
```

## Config precedence

Lowest to highest: dashboard **published** config < `data-*` attributes < `window.ChatFeatureSettings` / `init()` object < runtime `update()`. Client overrides may **restrict or restyle, never expand**; **policy fields** (domains, routing, hours, session timeouts, enabling disabled features, adding categories) are not client-overridable. The server re-validates everything it receives. Full rules: [contracts/widget-config.md](contracts/widget-config.md).

## data-* attributes (on the `<script>` tag)

| Attribute | Values |
|---|---|
| `data-widget-key` | the public key (`/w/<key>.js` already carries it) |
| `data-position` | `left` / `right` (or `bottom-left` / `bottom-right`) |
| `data-offset-x`, `data-offset-y`, `data-z-index` | numbers (px; clamped) |
| `data-locale` | locale code, e.g. `ar` (RTL aware) |
| `data-theme-mode` | `auto` / `light` / `dark` |
| `data-theme-primary`, `data-theme-accent` | hex colour |
| `data-theme-radius` | corner radius, px |
| `data-launcher-style` | `bubble` / `pill` |
| `data-launcher-label` | pill label text |
| `data-greetings` | `on` / `off` |
| `data-open-on-load` | `true` / `false` |
| `data-identity-token` | signed identity JWT (see below) |
| `data-categories` | comma-separated category slugs (a subset of the widget's enabled ones) |

## JS API (global: `window.ChatFeature`)

`window.ChatFeature(command, ...args)`; calls made before the loader has run are queued (`ChatFeature.q`) and replayed. Including the script twice is safe.

| Command | Purpose |
|---|---|
| `init(settings)` | Boot/merge settings (`widgetKey`, the override groups, `visitor`, `identityToken`, `openOnLoad`, `exposeMessageContent`). The script tag boots automatically; `init` is for the generic loader and for extra settings. |
| `open` / `close` / `toggle` | Control the panel |
| `show` / `hide` | Show/hide the launcher (hiding also closes the panel and suppresses greetings) |
| `shutdown` | Tear down and clear the stored session |
| `update(settings)` | Runtime override of the restyleable fields |
| `identify(jwt \| { token?, visitor? })` | Attach a signed identity |
| `setVisitor(fields)` | Set name/email/phone/meta (unsigned, **unverified**) |
| `setCategory(slug)` | Preselect a category |
| `startChat({ category?, message? })` | Open the panel and start the flow programmatically |
| `getState()` | `{ status, open, unread, agent?, ready, panelReady, widgetKey, configVersion }` |
| `on(event, fn)` / `off(event, fn)` | Subscribe/unsubscribe (`on` returns an unsubscribe function) |

Events (also `CustomEvent('chatfeature:<name>')` on `document` and `window`, non-bubbling): `ready` (the loader mounted), `open`, `close`, `chat-started`, `chat-ended`, `agent-joined`, `message-sent`, `message-received`, `unread-changed`, `greeting-shown`, `greeting-dismissed`, `rating-submitted`, `error`.
Event data is a whitelist of identifiers, counts and the agent's name; message text only reaches host code with `ChatFeature('init', { exposeMessageContent: true })`.

## postMessage protocol (summary)

- Namespace `chatfeature`, version `1`. Every message is an envelope `{ns:"chatfeature", v:1, type, id?, payload}`.
- Receivers check **`event.source`** and **`event.origin`** before acting; the loader only talks to the iframe it created and only to the app origin (never `'*'`).
- Handshake: iframe `ready` -> loader `init` (re-sent every second, 10 s timeouts) -> iframe `init:result`. Then host -> iframe `open`, `close`, `update`, `identify`, `setCategory`, `startChat`, `viewport`, `shutdown`, `session` (the answer to a drop, below); iframe -> host `session`, `state`, `unread`, `resize`, `close`, `event`, `error`.
- The visitor session is `{token, expiresAt, id}` in host `localStorage` (`chatfeature:<key>:session`), bound to the identity it was created for. The builder preview forwards unsaved drafts to the iframe through a same-origin relay (`draft` messages, `?preview=1`, admins only).
- **Several tabs, one stored session.** Every tab of the host page has its own panel but they share that one entry, and the server rotates the token (revoking the previous one) whenever a panel resumes a chat. So a panel never wipes the entry blindly: it sends `session { drop: <token> }` and the loader removes the entry only while it still holds that token. When another tab stored a newer session meanwhile, the loader answers with host `session { token, expiresAt }`, which the panel adopts (and carries on with the same chat); when nothing newer exists it answers `session {}` after clearing. A panel that gets no answer within 1.5 s (a loader that predates this) treats it as cleared. A bare `session null` from a panel still clears unconditionally. The same protocol runs when a tab's session no longer OWNS the chat although the token is still valid (the other tab resumed the chat and rotated: the old token lives on for 60 s but `GET /public/conversation` answers "no conversation" and a send is `404 not_found`): the older tab asks the loader which stored session is current, adopts it and carries on (a message that failed meanwhile keeps its Retry); with no newer session it shows the expired screen. It never reads "no conversation" as "the chat is over".

Full table: [contracts/postmessage-protocol.md](contracts/postmessage-protocol.md).

## Signed identity (HS256 JWT)

The host backend mints a JWT with the widget's rotatable `identity_secret` (shown once in the dashboard). Unsigned identity (`setVisitor`) is accepted but marked **unverified**. The verifier (`IdentityTokenVerifier`) ships in P3; the token is accepted by `POST /api/v1/public/widgets/{key}/sessions` (P4). Claims:

| Claim | Meaning |
|---|---|
| `iss` | **Required.** The widget's public key (`wk_...`) |
| `exp` | **Required**, at most 5 minutes ahead by default (`chat.identity.max_lifetime_seconds` = 300) |
| `sub` | Stable visitor/user id on the host site (recommended; optional, string <= 255) |
| `name`, `email`, `phone`, `meta` | Display fields / small key-value map (optional, type-checked) |
| `iat`, `nbf` | Optional; not more than 60 s in the future |
| `jti` | Optional unique token id. When present the token is **single use** per widget: a second use before it expires is refused. Omit it when the same token must be reusable for its short lifetime (a cached page) |

Only `alg: HS256` is accepted. The dashboard's Embed tab shows ready-to-copy, dependency-free examples (PHP, Node, Python) with the key filled in and the secret as a placeholder. With a library, the same claims:

PHP (`firebase/php-jwt`):

```php
use Firebase\JWT\JWT;

$jwt = JWT::encode([
    'iss' => 'wk_xxxxxxxxxxxxxxxxxxxx',   // the widget's public key
    'sub' => (string) $user->id, 'name' => $user->name, 'email' => $user->email,
    'iat' => time(), 'exp' => time() + 300,
], getenv('CHAT_IDENTITY_SECRET'), 'HS256');
```

Node (`jsonwebtoken`):

```js
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { sub: String(user.id), name: user.name, email: user.email },
  process.env.CHAT_IDENTITY_SECRET,
  { algorithm: 'HS256', expiresIn: '5m', issuer: 'wk_xxxxxxxxxxxxxxxxxxxx' },
);
```

Never mint the token in browser code; the secret must stay on the host backend. Rotating the secret (`POST /widgets/{ulid}/rotate-secret`) invalidates tokens signed with the old one at once.

**Known limitation: token lifetime vs. lazy session creation.** The panel creates the visitor session only right before the first write (starting a chat or sending an offline message), not when the page loads. An identity token is verified at that moment, so it must still be valid then: with the default 5-minute maximum lifetime, a visitor who sits on the page for longer than that before starting a chat gets `422 identity_token` ("We couldn't verify your sign-in. Reload the page and try again.") and has to reload to receive a fresh token. Hosts that render long-lived pages should mint the token close to when the visitor opens the chat (`ChatFeature('identify', jwt)` on the launcher's `open` event, or a short `exp` plus a refresh timer). The same applies to a single-use token (`jti`): it is spent by the session creation, not by the page load.

## Greeting behaviour

Admin-defined pool of messages (agent name/avatar, weights, per-locale). On every page load (after **3 s**) and every N minutes (default **30**) a **weighted random** message is picked (never the same twice in a row). The launcher does a 3D flip to the agent face, a popup shows beside the bubble (bottom sheet on mobile), auto-hides after a configurable time, and the launcher flips back. It pauses while the tab is hidden; `prefers-reduced-motion` uses a crossfade. Dismiss policy: `session` | `interval` | `never`. Greetings are suppressed while a chat is queued or active. With the panel closed, a new agent reply triggers shake/pulse plus an unread badge.

## Domain whitelist, CSP, CORS

- A whitelist entry is `host`, `host:port` or `*.host[:port]`, optionally prefixed with `https://` (the default, dropped when stored) or `http://` (kept: the admin's explicit permission for a plain-http site, which then also admits https).
  A bare entry admits **https only**; plain `http://` origins are admitted without the prefix only for development hosts (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`).
- A wildcard must hang below a name one party owns: `*.example.com` yes, `*.com`, `*.co.uk` or `*.github.io` no (built-in list of public suffixes, `PublicSuffixes`, which is **partial**). Entries are at most 255 characters.
- `frame-ancestors` CSP on `/embed/{key}` limited to the widget's whitelisted domains (`'none'` when the list is empty; the builder preview uses `'self'`).
- The public config/availability API checks the browser `Origin` against the whitelist (the `Referer` is not used there; the script endpoint `/w/{key}.js` is the one place that looks at it: a `Referer` origin that is not on the list gets `403`, no `Referer` is served); CORS echoes only whitelisted origins (plus this app's own origin for the dashboard preview). Requests without an `Origin` are refused unless the widget allows non-browser clients. Session creation (`POST /public/widgets/{key}/sessions`) goes through the same gate; every later visitor call carries only the visitor bearer token (no cookies, no origin gate: the token is bound to one session and widget).
- Rate limits (per minute, `config/chat.php` -> `rate_limits`): per client network (IPv4 address / IPv6 /64) across all widget keys, evaluated before the key is looked up; a lower limit on lookups of unknown keys; per widget (and per allowed origin) budgets that only requests of allowed origins use up. A `429` carries `Retry-After` and, for an origin that was allowed to use the widget a moment ago, the same CORS headers as a `200` (plus `Access-Control-Expose-Headers: Retry-After`).
- Unlisted origins are blocked for CORS and framing (tested in P3); session creation applies the same origin rule (P4).

## What the panel does with what the host gives it (P4)

- **Origins.** The panel talks to the API only at the origin it was served from (`window.__PNE_EMBED__.appOrigin`, inlined by the server). `init.boot.api.base` / `appOrigin` that name another origin are ignored, and a custom `fontUrl` is accepted only from that origin or the two font hosts (`fonts.googleapis.com`, `fonts.bunny.net`).
- **Boot copy.** The boot `categories` now keep each category's `description`, `icon` and `color` (the panel re-validates them), so the topic picker does not depend on the config call. The panel still reads `GET /public/widgets/{key}/config` once while booting for fresh availability; it waits at most 1.5 s for it before rendering from the boot copy, and applies a slower answer (a corrected availability) when it arrives.
- **Page data.** `init.page.title` is capped at 255 characters (the server's limit), `url` / `referrer` at 2000. Visitor fields the server would refuse (`name` over 120 characters, an `email` that is not an address or over 190 characters, a `phone` outside `0-9 + ( ) . - space`, 3 to 40 characters) are dropped by the loader and again by the panel instead of being sent; a `422` that blames only `visitor.*`, `page.*` or `locale` is retried once without them.
- **`startChat`** that reaches the panel while it is still booting (the loader flushes queued host messages right after `init:result`) is remembered and applied once the first screen is known; it is ignored when the boot resumes a running chat.
- **Limits.** A session response may carry `limits` (`maxMessageLength`, `attachmentMaxBytes`, `attachmentMaxDimension`, `attachmentMaxPerMessage`); the composer and the offline form follow them and fall back to 4000 characters, 5 MB and 4 images when the server sends none.
- **Time-outs.** Every visitor request has a 20 s deadline (uploads 90 s) and fails as a network error; a message that cannot be sent shows why and offers "Retry" only when retrying can help.
- **Ratings off.** When the widget has `features.rating` off, an ended chat goes straight to the thank-you screen and the panel tells the server (`POST .../rating/skip`) so it closes at once.
