# postMessage protocol (host page <-> chat iframe)

> Status: contract v1, **host side implemented in P3 and reviewed** (loader `resources/widget/src/`, 3B); the iframe side (4D embed panel) is **not built yet**: `resources/js/embed/main.tsx` is a stub that never says `ready`, so until P4 the real handshake is only exercised against `resources/widget/dev/panel-mock.html` and the Vitest bridge tests.
> Final names here override the drafts in `docs/widget-embed-api.md`.

The loader (vanilla TS, Shadow DOM launcher) and the React chat panel (`/embed/{key}` iframe) talk **only** through `postMessage`.
No cookies, no shared storage: the visitor token is persisted by the **loader** in host-origin `localStorage`
(`chatfeature:<publicKey>:session`) and handed to the iframe on `init`.

## Envelope

```ts
type Msg<T extends string = string, P = unknown> = { ns: 'chatfeature'; v: 1; type: T; id?: string; payload: P };
```

- `id` (uuid) is set on requests that expect an answer; the answer reuses it with `type: '<request>:result'`. Today only `init` is answered this way (`init:result`).
- Receivers **ignore** anything whose `ns !== 'chatfeature'` or `v` is unsupported (log once in dev); unknown `type`s are ignored silently.
- Payloads are plain structured-cloneable JSON. Never HTML, functions or DOM nodes.

## Origin and source checks (mandatory, both directions)

| Receiver | Checks |
|---|---|
| Loader (host page) | `event.origin === boot.api.appOrigin` **and** `event.source === iframe.contentWindow`. Outbound is always `postMessage(msg, appOrigin)`, never `'*'`. (`appOrigin` itself must equal the origin the loader script was served from, see widget-config.md "Boot trust rules".) |
| Iframe (panel, P4) | `event.source === window.parent` **and** `event.origin` ∈ the widget's allowed hosts (list inlined in the iframe page boot data from `widget_domains`; `*.example.com` wildcards honoured). After the first valid `init` it replies/sends only to that origin (`targetOrigin = event.origin`, never `'*'`). |
| Builder preview | The iframe additionally accepts `draft` messages only when the page URL has `?preview=1`, the viewer is an authenticated admin and `event.origin === appOrigin`. (Panel side: P4.) |

The iframe is also protected by `Content-Security-Policy: frame-ancestors <widget_domains>`; the checks above are defence in depth. The loader creates the iframe with
`sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"`, `allow="clipboard-write"`, `referrerpolicy="strict-origin-when-cross-origin"`, `src = boot.api.embed`
and `title` = the widget's `title` text. The iframe is created lazily (first open, or at boot when a stored session exists).

## Handshake (loader <-> panel)

1. The loader creates the iframe and starts listening **before** it loads, and arms a 10 s `ready_timeout`.
2. The panel sends `ready { protocol: 1 }` (a different `protocol` is ignored). Each `ready` starts a fresh handshake (new `id`, acknowledgement reset), so a panel that reloads is re-initialised.
3. The loader answers `init` (with an `id`) and **re-sends it every 1 s** until it is acknowledged, building the payload anew each time (viewport and page stay fresh); a 10 s `init_timeout` bounds the wait.
4. Acknowledged by `init:result` with the same `id` **or**, for panels that do not ack, by the panel's first `state` / `session` message. Host messages sent before the ack (`open`, `update`, `identify`...) are queued and flushed in order on ack (only the latest `viewport` is kept).
5. **Timeout** (either one): the loader emits `error { code: 'ready_timeout' | 'init_timeout', message: 'Panel handshake failed' }`, **closes the panel, unlocks host scrolling and throws the iframe away**; the next open starts over.

`getState().panelReady` is true once the init was acknowledged. The loader **event** `ready` (below) is unrelated to the panel's `ready` message: it means the loader itself has mounted.

**Before the handshake (config load).** When the loader has no usable boot config (generic loader, or an inlined config that failed the trust checks) it fetches `GET {scriptOrigin}/api/v1/public/widgets/{key}/config`; a failed load emits `error { code: 'config_failed' }` **once**, then retries after **2 s, 8 s and 30 s** (and at once on the browser's `online` event or a later `ChatFeature('init')`). The loader bundle itself starts with the marker comment `/*! pne-chat-loader v1 */`.

## Host -> iframe

| `type` | `payload` | Notes |
|---|---|---|
| `init` | `{ boot, visitorSession?: { token, expiresAt }, identityToken?: string, visitor?: { name?, email?, phone?, meta? }, page: { url, title, referrer }, overrides: object, embedMode: 'launcher', viewport: { width, height, keyboardInset } }` | First message. `boot` = the **rebuilt** boot config (below). `page.*` are capped (2000 / 300 / 2000 chars). `visitorSession` only when a valid stored session exists. |
| `open` / `close` | `{}` | Panel visibility driven by the launcher / JS API. |
| `update` | `{ overrides: object }` | Runtime `ChatFeature('update', …)`; the panel re-merges (the loader already applied the restriction rule). |
| `identify` | `{ token?: string, visitor?: { name?, email?, phone?, meta? } }` | Signed identity JWT or unsigned prefill. |
| `setCategory` | `{ slug: string }` | Pre-selects a category (must be in the effective subset). |
| `startChat` | `{ category?: string, message?: string }` | Programmatic start (honours pre-chat form rules); the loader opens the panel first. |
| `viewport` | `{ width, height, keyboardInset }` | iOS keyboard / `visualViewport` changes (about one per frame, repeats skipped). |
| `shutdown` | `{}` | Clears state; loader removes the iframe and the stored session. |

There is **no `draft` command on the host JS API and the loader never forwards one.** `draft` exists only on the builder preview path: the builder page posts `{ns:'chatfeature', v:1, type:'draft', payload:{ config, greetings }}` to a same-origin `srcdoc` host document,
whose relay (`resources/js/components/widgets/preview-host.ts`) forwards it to the chat iframe (targetOrigin = embed origin) and applies the restyleable part (`defaultLocale, theme, launcher, texts, greetings`) through `ChatFeature('update', …)`.
Changes `update` cannot express (a text/URL removed, the greeting pool or the categories changed) **reboot the preview host page** (debounced 900 ms) instead.

`embedMode` is always `'launcher'` from the loader. The plain inline iframe (`/embed/{key}?mode=inline`) and the hosted page (`/c/{key}`) have no loader to send `init`: how those panels boot (and keep their session) is **open, a P4 design item**; the Blade shell only tells them `mode` through `window.__PNE_EMBED__`.

### `init.boot` and `init.overrides`

- `boot` is rebuilt by the loader from validated fields (never the object the page handed it, no raw pass-through): `{ v: 1, key, configVersion, generatedAt?, locale?, availability?, api: { base, embed, appOrigin }, config: { …sanitised base config (defaultLocale, localeDetect, theme, launcher, texts, features, greetings), v: 1, preChat?, hours? }, greetings, categories }`.
  Note `categories` are reduced to `{ slug, label }` (description / icon / colour of the server config are dropped by the loader: P4's panel must fetch the public config endpoint if it wants them, or the loader must be extended).
- `overrides` is **pre-restricted** by the loader: only `locale`, `defaultLocale`, `theme`, `launcher`, `texts`, `features` (only entries set to `false`, plus `sounds` / `titleBadge` in either direction) and `categories` (the effective slug subset). Visitor and identity travel as their own fields; greetings are the loader's own.

## Iframe -> host

| `type` | `payload` | Notes |
|---|---|---|
| `ready` | `{ protocol: 1 }` | Iframe booted and listening; starts the handshake above. |
| `init:result` | `{}` (ignored) | Acknowledges `init`; must carry the `id` of the `init` it answers. |
| `session` | `{ token, expiresAt } \| null` | New/cleared visitor session; the loader persists it in host `localStorage` (token <= 1024 chars, `expiresAt` a parseable date; anything else, `null` included, clears it). |
| `state` | `{ status: 'idle' \| 'prechat' \| 'queued' \| 'active' \| 'ended' \| 'offline' \| 'closed', open: boolean, unread: number, agent?: { name, avatarUrl? } }` | Source of truth for the launcher badge and `getState()`. The loader substitutes its own `open`, clamps `unread` to 0..999 and keeps only `https` avatar URLs (plain `http` only for development hosts). `queued`/`active` suppress greetings. |
| `unread` | `{ count: number, preview?: string, agent?: { name, avatarUrl? } }` | Drives the launcher shake/pulse + sound + optional title badge while the panel is closed (counted as 0 while it is open). Emits `unread-changed`. |
| `resize` | `{ mode: 'panel' \| 'fullscreen' }` | Loader sizes the iframe (fullscreen = `position:fixed; inset:0`, body scroll lock) — iframe never resizes itself. |
| `close` | `{}` | Visitor pressed the panel's close button, **or pressed Escape while focus is inside the iframe**: the loader cannot see key events inside the frame, so the panel must send this itself. |
| `event` | `{ name: ChatEventName, data?: object }` | Re-dispatched by the loader as `CustomEvent('chatfeature:<name>')` and to `ChatFeature.on`, **only for the panel-owned names** below. |
| `error` | `{ code: string, message: string }` | Non-fatal; loader emits `chatfeature:error` (code <= 64, message <= 300 chars). |

`ChatEventName` = `ready | open | close | chat-started | chat-ended | agent-joined | message-sent | message-received | unread-changed |
greeting-shown | greeting-dismissed | rating-submitted | error`.
**Panel-owned** (the only ones accepted from an `event` message): `chat-started`, `chat-ended`, `agent-joined`, `message-sent`, `message-received`, `rating-submitted`.
**Loader-owned** (never re-dispatched from the panel; an `event` message naming one is ignored): `ready` (`{ widgetKey, configVersion }`, the loader mounted), `open`, `close`, `unread-changed` (`{ count, preview?, agent? }`), `greeting-shown` (`{ id, agentName }`), `greeting-dismissed` (`{ id, reason }`), `error`.

**What host code may see** (everything host-visible is readable by every script on the page): event `data` is rebuilt from a whitelist, typed and capped — `conversationId`, `messageId`, `category`, `status`, `reason`, `rating`, `count`, `at`, `name`, `agentName`
(strings <= 100 chars, control characters stripped; numbers and booleans as is) and `agent: { name }`. Message text (`body`, `text`, `message`, `preview`, `comment`, each <= 2000 chars) is added **only** when the host booted with
`exposeMessageContent: true` (widget-config.md). DOM events are `CustomEvent`s on **`document` and `window`**, **non-bubbling and non-composed** (listeners on either receive them directly; they travel no further).

## Visitor session in host storage

Key `chatfeature:<publicKey>:session`, value `{ "token": string, "expiresAt": ISO-8601, "id": string }`. `id` fingerprints the identity the session was created for (the identity JWT's `sub`, else the unsigned `visitor.email`, else `anonymous`; a short non-cryptographic hash).
On boot and on every `init` the loader reads it back, and **deletes it on sight** when it is corrupt, expired or its `id` no longer matches the current identity (a changed identity also throws the panel away and rebuilds it). `shutdown` removes it.
Residual risk, accepted by design: the token is readable by any script on the host page (it is what lets Safari ITP not break sessions); it is scoped to one visitor's own conversation, expires and is rejected server-side once revoked.
Greeting state uses `chatfeature:<key>:greeting:last` (localStorage) and `…:greeting:dismissed` (sessionStorage); storage failures fall back to memory.

## JS API (host global)

`window.ChatFeature(command, ...args)` with a stub queue (`ChatFeature.q`) so calls made before the loader finishes are replayed (an array-like entry of <= 20 items; junk is skipped; at most 50 commands are held before a widget exists). Including the script twice is a no-op.
Commands: `init, open, close, toggle, show, hide, shutdown, update, identify, setVisitor, setCategory, startChat, getState, on, off` (`on` returns an unsubscribe function; unknown event names and non-functions are ignored). Commands issued before the widget mounted are queued inside it.
`getState()` returns the last `state` payload plus `{ ready, panelReady, widgetKey, configVersion }` (`ready` = loader mounted, `panelReady` = panel handshake done; `open` and `unread` are the loader's own values).
A page-level `Escape` (not default-prevented) on the **host document** closes an open panel; inside the launcher's Shadow DOM it first dismisses a visible greeting.

## Mobile / viewport rules

Below 480 px viewport width (`max-width: 479.98px`) the loader handles `resize: fullscreen` itself (iframe `position:fixed; inset:0`, locks host scroll — unlocked again on close, handshake timeout or shutdown)
and forwards `visualViewport` changes as `viewport` messages so the panel can keep the composer above the iOS keyboard (`100dvh`, safe-area insets).
