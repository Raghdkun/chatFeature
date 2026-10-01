# postMessage protocol (host page <-> chat iframe)

> Status: contract v1 (written before P3). Owners: 3B loader (host side), 4D embed panel (iframe side). Final names here override
> the drafts in `docs/widget-embed-api.md`.

The loader (vanilla TS, Shadow DOM launcher) and the React chat panel (`/embed/{key}` iframe) talk **only** through `postMessage`.
No cookies, no shared storage: the visitor token is persisted by the **loader** in host-origin `localStorage`
(`chatfeature:<publicKey>:session`) and handed to the iframe on `init`.

## Envelope

```ts
type Msg<T extends string = string, P = unknown> = { ns: 'chatfeature'; v: 1; type: T; id?: string; payload: P };
```

- `id` (uuid) is set on requests that expect an answer; the answer reuses it with `type: '<request>:result'`.
- Receivers **ignore** anything whose `ns !== 'chatfeature'` or `v` is unsupported (log once in dev).
- Payloads are plain structured-cloneable JSON. Never HTML, functions or DOM nodes.

## Origin and source checks (mandatory, both directions)

| Receiver | Checks |
|---|---|
| Loader (host page) | `event.origin === boot.api.appOrigin` **and** `event.source === iframe.contentWindow`. |
| Iframe (panel) | `event.source === window.parent` **and** `event.origin` ∈ the widget's allowed hosts (list inlined in the iframe page boot data from `widget_domains`; `*.example.com` wildcards honoured). After the first valid `init` it replies/sends only to that origin (`targetOrigin = event.origin`, never `'*'`). |
| Builder preview | The iframe additionally accepts `draft` messages only when the page URL has `?preview=1`, the viewer is an authenticated admin and `event.origin === appOrigin`. |

The iframe is also protected by `Content-Security-Policy: frame-ancestors <widget_domains>`; the checks above are defence in depth.

## Host -> iframe

| `type` | `payload` | Notes |
|---|---|---|
| `init` | `{ boot, visitorSession?: { token, expiresAt }, identityToken?: string, visitor?: { name?, email?, phone?, meta? }, page: { url, title, referrer }, overrides: object, embedMode: 'launcher' \| 'inline', viewport: { width, height } }` | First message. `boot` = resolved boot config (see widget-config.md). |
| `open` / `close` | `{}` | Panel visibility driven by the launcher / JS API. |
| `update` | `{ overrides: object }` | Runtime `ChatFeature('update', …)`; iframe re-merges with the restriction rule. |
| `identify` | `{ token?: string, visitor?: { name?, email?, phone?, meta? } }` | Signed identity JWT or unsigned prefill. |
| `setCategory` | `{ slug: string }` | Pre-selects a category (must be in the enabled subset). |
| `startChat` | `{ category?: string, message?: string }` | Programmatic start (honours pre-chat form rules). |
| `viewport` | `{ width, height, keyboardInset }` | iOS keyboard / `visualViewport` changes. |
| `shutdown` | `{}` | Clears state; loader removes the iframe and the stored session. |
| `draft` | `{ config: object, greetings?: object[] }` | Builder preview only (see checks). |

## Iframe -> host

| `type` | `payload` | Notes |
|---|---|---|
| `ready` | `{ protocol: 1 }` | Iframe booted and listening; loader then sends `init` (retries until acknowledged, max 10 s). |
| `session` | `{ token, expiresAt } \| null` | New/cleared visitor session; loader persists it in host `localStorage`. |
| `state` | `{ status: 'idle' \| 'prechat' \| 'queued' \| 'active' \| 'ended' \| 'offline' \| 'closed', open: boolean, unread: number, agent?: { name, avatarUrl? } }` | Source of truth for launcher badge and DOM events. |
| `unread` | `{ count: number, preview?: string, agent?: { name, avatarUrl? } }` | Drives the launcher shake/pulse + sound + optional title badge while the panel is closed. |
| `resize` | `{ mode: 'panel' \| 'fullscreen' }` | Loader sizes the iframe (fullscreen = `position:fixed; inset:0`, body scroll lock) — iframe never resizes itself. |
| `close` | `{}` | Visitor pressed the panel's close button. |
| `event` | `{ name: ChatEventName, data?: object }` | Re-dispatched by the loader as `CustomEvent('chatfeature:<name>')` and to `ChatFeature.on`. |
| `error` | `{ code: string, message: string }` | Non-fatal; loader emits `chatfeature:error`. |

`ChatEventName` = `ready | open | close | chat-started | chat-ended | agent-joined | message-sent | message-received | unread-changed |
greeting-shown | greeting-dismissed | rating-submitted | error`. (`greeting-*` are emitted by the loader itself, not the iframe.)

## JS API (host global)

`window.ChatFeature(command, ...args)` with a stub queue (`ChatFeature.q`) so calls made before the loader finishes are replayed.
Commands: `init, open, close, toggle, show, hide, shutdown, update, identify, setVisitor, setCategory, startChat, getState, on, off`.
`getState()` returns the last `state` payload plus `{ ready, widgetKey, configVersion }`.

## Mobile / viewport rules

Below 480 px viewport width the loader sends `resize: fullscreen` handling to itself (iframe `position:fixed; inset:0`, locks host scroll)
and forwards `visualViewport` changes as `viewport` messages so the panel can keep the composer above the iOS keyboard (`100dvh`, safe-area insets).
