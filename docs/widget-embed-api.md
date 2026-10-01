# Widget embed API

> Status: Design - implemented in P3/P4. Names marked "draft" are proposals; the final contract is written to `docs/contracts/*` before the tracks start.

## Architecture in one paragraph

A tiny vanilla-TS IIFE loader (budget **<= 15 KB gz**, enforced in CI) mounts the launcher and greeting popup in an open **Shadow DOM**. The chat panel is a React **iframe** at `/embed/{publicKey}`. This gives CSS isolation both ways, keeps host JS/XSS away from the chat and token, and the host CSP only needs `script-src` + `frame-src`. There are **no cookies**: the visitor token lives in host-origin `localStorage` and is passed to the iframe by `postMessage`, so Safari ITP / partitioned storage cannot break it.

## Embed variants

| Variant | Use |
|---|---|
| Script snippet `/w/{key}.js` | Boot config inlined, ETag-cached. Primary embed. |
| Generic `loader.js` + `data-widget-key` | One script, key passed as an attribute |
| Inline iframe embed | Chat panel inside a page region |
| Hosted page `/c/{key}` | Standalone page; WhatsApp links/QR |

```html
<script async src="https://chat.example.com/w/wk_XXXX.js" data-position="left"></script>
```

## Config precedence

Lowest to highest: dashboard **published** config < `data-*` attributes < `window.ChatFeatureSettings` / `init()` object < runtime `update()`. **Policy fields** (domains, timeouts, enabled categories) are not client-overridable.

## data-* attributes (draft)

Only `data-widget-key` and `data-position` are named in the plan; the rest are inferred from features the plan describes.

| Attribute | Values | Source |
|---|---|---|
| `data-widget-key` | public key | plan |
| `data-position` | `left` / `right` | plan |
| `data-locale` | locale code (RTL aware) | inferred (i18n/RTL) |
| `data-theme` | `light` / `dark` / `auto` | inferred (builder light/dark) |
| `data-color` | CSS color | inferred (customization) |
| `data-category` | category id | inferred (`setCategory`) |
| `data-greeting` | `on` / `off` | inferred (greeting) |

## JS API (draft global: `window.ChatFeature`)

| Command | Purpose |
|---|---|
| `init(config)` | Boot with an object (precedence above) |
| `open` / `close` / `toggle` | Control the panel |
| `show` / `hide` | Show/hide the launcher |
| `shutdown` | Tear down and clear state |
| `update(config)` | Runtime config override (non-policy fields) |
| `identify(jwt)` | Attach a signed identity |
| `setVisitor(fields)` | Set name/email/phone (unverified) |
| `setCategory(id)` | Preselect a category |
| `startChat()` | Start the flow programmatically |
| `getState()` | Read open/unseen/connection state |
| `on(event, fn)` / `off(event, fn)` | Subscribe/unsubscribe |

Events are also dispatched as DOM `CustomEvent`s named `chatfeature:*`. Proposed names (draft): `ready`, `open`, `close`, `chat-started`, `chat-ended`, `unseen-changed`.

## postMessage protocol (draft)

- Namespace `chatfeature`, version `v1`. Every message is an envelope such as `{ns:"chatfeature", v:1, type, payload}`.
- Receivers check **`event.source`** and **`event.origin`** before acting.
- The plan fixes these roles; final type names are TBD in the contract:

| Direction | Type (draft) | Carries |
|---|---|---|
| loader -> iframe | `init` | visitor token (from host `localStorage`), resolved config, identity |
| loader -> iframe | `update` | runtime config / commands |
| iframe -> loader | `ready` | iframe booted |
| iframe -> loader | `token` | new/rotated visitor token to persist on the host origin |
| iframe -> loader | `state` | open/close request, size/viewport, unseen count (badge) |
| builder -> preview | `draft` | unsaved draft config for the live preview |

## Signed identity (HS256 JWT)

The host backend mints a JWT with the widget's rotatable `identity_secret`. Unsigned identity (`setVisitor`) is accepted but marked **unverified**. Claims (draft):

| Claim | Meaning |
|---|---|
| `sub` | Stable visitor/user id on the host site (required) |
| `name`, `email`, `phone` | Display fields (optional) |
| `iat`, `exp` | Issued-at / short expiry (required; keep it minutes) |

PHP (`firebase/php-jwt`):

```php
use Firebase\JWT\JWT;

$jwt = JWT::encode([
    'sub' => (string) $user->id, 'name' => $user->name, 'email' => $user->email,
    'iat' => time(), 'exp' => time() + 600,
], getenv('CHAT_IDENTITY_SECRET'), 'HS256');
```

Node (`jsonwebtoken`):

```js
const jwt = require('jsonwebtoken');
const token = jwt.sign(
  { sub: String(user.id), name: user.name, email: user.email },
  process.env.CHAT_IDENTITY_SECRET,
  { algorithm: 'HS256', expiresIn: '10m' },
);
```

Never mint the token in browser code; the secret must stay on the host backend.

## Greeting behaviour

Admin-defined pool of messages (agent name/avatar, weights, per-locale). On every page load (after **3 s**) and every N minutes (default **30**) a **weighted random** message is picked (never the same twice in a row). The launcher does a 3D flip to the agent face, a popup shows beside the bubble (bottom sheet on mobile), auto-hides after a configurable time, and the launcher flips back. It pauses while the tab is hidden; `prefers-reduced-motion` uses a crossfade. Dismiss policy: `session` | `interval` | `never`. With the panel closed, a new agent reply triggers shake/pulse plus an unseen badge.

## Domain whitelist, CSP, CORS

- `frame-ancestors` CSP on `/embed/{key}` limited to the widget's whitelisted domains.
- Origin/Referer checks on public API writes; CORS echoes only whitelisted origins; rate limits apply.
- Host page CSP needs `script-src` (our host) and `frame-src` (our host) only.
- Unlisted origins are blocked for CORS, framing and writes (tested in P3).
