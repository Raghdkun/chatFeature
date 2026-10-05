# Widget config schema

> Status: contract v1, **implemented in P3 and reviewed** (`v0.3.0`; this text is the implemented truth, verified against the code). Owners: P3 3A (PHP `WidgetConfig` Data + validation), 3B (loader), 3C (builder UI),
> P4 4D (embed panel). The PHP class is the source of truth (`app/Domain/Widgets/Data/WidgetConfigData.php`, `#[TypeScript]`);
> this document defines the shape and defaults it implements.

A widget has a **published** config (`widgets.config`, versioned by `config_version`) and a **draft** (`widgets.draft_config`).
Greetings, domains and category links live in their own tables and are merged into the *resolved boot config* below.
Five operational settings exist twice, as `widgets` columns and as config fields; **the columns are authoritative** at runtime (`ConfigMirror`):
`locale` = `defaultLocale`, `offline_mode` = `hours.mode`, `timezone` = `hours.timezone`, `queue_timeout_seconds` = `routing.queueTimeoutSeconds`,
`idle_timeout_minutes` = `session.idleTimeoutMinutes`. A settings PATCH writes them into BOTH the published and the draft config; Publish copies them back to the columns.

## Config object (`v: 1`)

```jsonc
{
  "v": 1,
  "defaultLocale": "en",
  "localeDetect": true,                       // pick visitor browser locale if a texts block exists for it
  "theme": {
    "mode": "auto",                           // "auto" | "light" | "dark"
    "primary": "#0f766e", "primaryText": "#ffffff",
    "accent": "#D97706", "surface": "#ffffff", "text": "#0f172a",
    "fontFamily": "Inter, system-ui, sans-serif",
    "fontUrl": null,                          // https URL to a stylesheet; allowed hosts: fonts.googleapis.com, fonts.bunny.net, own origin
    "radius": 16,                             // px, 0..28
    "shadow": "soft",                         // "none" | "soft" | "strong"
    "launcherSize": "md",                     // "sm" 48 | "md" 60 | "lg" 72  (px)
    "panelWidth": 380, "panelHeight": 620,    // px maxima; full-screen below 480px viewport width
    "position": "bottom-right",               // "bottom-right" | "bottom-left"  (physical corner; internals are logical/RTL-safe)
    "offsetX": 20, "offsetY": 20, "zIndex": 2147483000
  },
  "launcher": {
    "style": "bubble",                        // "bubble" | "pill"
    "icon": "chat",                           // "chat" | "help" | "sparkle" | "custom"  (custom needs iconUrl)
    "iconUrl": null, "label": "Chat with us", // label only for style "pill"; at most 40 characters
    "avatarUrl": null                         // default agent face for the flip when a greeting has none
  },
  "texts": {                                  // per locale; missing keys fall back to defaultLocale then to built-in English
    "en": {
      "title": "Support", "subtitle": "We usually reply in a few minutes",
      "welcome": "Hi! How can we help you today?", "categoryPrompt": "What do you need help with?",
      "connecting": "Connecting you to an agent…", "noAgents": "No agent is available right now.",
      "offlineTitle": "Leave us a message", "offlineBody": "We'll get back to you by email.",
      "placeholder": "Type your message…", "send": "Send", "attach": "Attach image",
      "endChat": "End chat", "ratingTitle": "How was this chat?", "ratingPlaceholder": "Add a comment (optional)",
      "thanks": "Thanks for your feedback!", "startNewChat": "Start a new chat", "poweredBy": "Powered by PNE Chat",
      "closeChat": "Close chat", "unread": "unread messages", "dismiss": "Dismiss"   // aria-labels of the loader's launcher and greeting popup
    }
  },
  "features": {
    "attachments": true, "rating": true, "sounds": true, "preChat": true,
    "whatsapp": false,                        // never offered to visitors until P6 (the resolver forces it to false)
    "offlineForm": true, "titleBadge": false, "endChatByVisitor": true, "poweredBy": true
  },
  "preChat": {
    "fields": {
      "name":  { "enabled": true,  "required": true  },
      "email": { "enabled": true,  "required": false },
      "phone": { "enabled": false, "required": false }
    },
    "consentText": null                       // when set (<= 500 chars), an unchecked consent checkbox gates "Start chat"
  },
  "greetings": {                              // the message pool itself is stored in widget_greetings
    "enabled": true, "onPageLoad": true,
    "delaySeconds": 3, "intervalMinutes": 30, "autoHideSeconds": 180,
    "dismissPolicy": "session",               // "session" | "interval" | "never"
    "showAgent": true
  },
  "hours": {
    "mode": "auto_hours",                     // "auto_hours" | "always_online" | "always_offline"
    "timezone": "UTC",
    "schedule": [ { "day": 1, "start": "09:00", "end": "17:00" } ],   // day 0=Sun..6=Sat, several non-overlapping ranges per day; default Mon-Fri 09:00-17:00; end may be "24:00"
    "holidays": [ { "date": "2026-12-25", "label": "Christmas" } ]    // label is ALWAYS a string ("" when the admin gave none, never null)
  },
  "routing": {
    "waves": [ { "afterSeconds": 0, "statuses": ["online"] }, { "afterSeconds": 20, "statuses": ["away"] } ],
    "wakeOfflineViaPush": false,
    "queueTimeoutSeconds": 90
  },
  "session": { "idleTimeoutMinutes": 120 }    // mirrors widgets.idle_timeout_minutes (admin-configurable, default 120)
}
```

### Validation (`WidgetConfigValidator`, the single source of the schema)

- **Strict**: unknown keys are rejected on write with a field-level error (`config.theme.colour`: "Unknown option."); scalar types are exact (`"16"` is not an integer);
  numbers outside their range are **rejected, never clamped**; everything missing is filled from the defaults above, so the stored config is always complete.
  `null` for a field whose default is not null means "use the default" (an emptied input falls back; a cleared `launcher.label` is back at `Chat with us`).
- Errors come back as `422 validation_failed` with `details` keyed by the dotted path under the request key (`config.theme.panelHeight`, `config.hours.schedule.0.end`).
- Colours: 3/6/8-digit hex. URLs (`launcher.iconUrl`, `launcher.avatarUrl`, greeting avatars): `https:` or same-origin relative; `theme.fontUrl` additionally only on `fonts.googleapis.com`, `fonts.bunny.net` or this app's host.
  `theme.fontFamily`: letters, digits, spaces and `, . _ - ' "` only (<= 200). Locale codes (`defaultLocale`, keys of `texts`) are BCP-47-ish (`en`, `pt-BR`, `zh-Hant-TW`), **at most 12 characters** (the column width), at most 20 locales.
- Ranges: `radius` 0..28, `panelWidth` 280..600, `panelHeight` 360..900, `offsetX/Y` 0..200, `zIndex` 1..2147483647, `launcher.label` <= 40, every text <= 500, `consentText` <= 500,
  `greetings.delaySeconds` 0..600, `intervalMinutes` 1..1440, `autoHideSeconds` 3..3600, schedule <= 42 ranges, holidays <= 400 (label <= 80, dates unique `YYYY-MM-DD`),
  `routing.waves` 1..5 strictly increasing `afterSeconds` 0..600 with 1..3 distinct statuses, `queueTimeoutSeconds` 15..600, `idleTimeoutMinutes` 5..10080.
  `resources/js/lib/limits.ts` repeats these for the dashboard and is pinned to the PHP rules by a test.
- Cross-field: a required pre-chat field must be enabled; `icon: custom` needs `iconUrl`; a schedule range must end after it starts and ranges of one day may not overlap.
- Visitor-facing text keys are exactly `WidgetTexts::keys()` (the 20 above); any other key is rejected. (The loader additionally reads a `launcherLabel` text from *client-supplied* `texts` overrides, see below; it is not a dashboard key.)

## Greeting pool item (table `widget_greetings`)

`{ id (ulid), body (text, no length cap besides 2000), agentName?, agentAvatarUrl?, locale? (null = any), weight (int 1..100, default 1), isActive, sortOrder }`; at most 100 per widget.
`body` is plain text (rendered as text, never HTML; control characters rejected). Selection: weighted random among active items matching the visitor locale
(fall back to locale-less items), never the same item twice in a row. Greetings, domains and category links are **not** part of the draft: they apply to visitors as soon as they are saved.

## Resolved boot config (what `/w/{key}.js` inlines and `GET /api/v1/public/widgets/{key}/config` returns)

```jsonc
{
  "v": 1, "key": "wk_…", "configVersion": 12, "generatedAt": "2026-09-30T12:00:00.000Z",
  "locale": "en",                                                          // the locale the texts were resolved for (after fallbacks)
  "api": { "base": "https://chat.example.com/api/v1/public", "embed": "https://chat.example.com/embed/wk_…", "appOrigin": "https://chat.example.com" },
  "config": { /* the object above, PUBLISHED, minus routing and session (server-side policy); `hours`, `preChat` stay */ },
  "greetings": [ { "id": "…", "body": "…", "agentName": "Sara", "agentAvatarUrl": "https://…", "locale": null, "weight": 2 } ],
  "categories": [ { "slug": "billing", "label": "Billing", "description": null, "icon": null, "color": null } ],   // active categories enabled on this widget, in display order; label already localised
  "availability": { "online": true, "openNow": true, "nextOpenAt": null, "categories": [ { "slug": "billing", "online": true } ], "whatsapp": { "enabled": false } }
}
```

- `api.*` is built from the **`app.url` setting**, never from the request's Host header (a spoofed Host cannot poison cached responses).
- `config.texts` carries complete blocks (locale -> default locale -> built-in English applied). With `?locale=xx` only the default block and the block the request resolved to are sent;
  without it every block. Locale matching: exact (case-insensitive), then the language (`pt-BR` -> `pt`), then any variant of that language (`ar` -> `ar-SA`), else the widget's default locale.
  Category labels use `name_i18n` by the same matching, else the base name. Greetings keep locale-less items and those of the same language.
- `availability.online` = open per hours AND some enabled category has an available agent; it stays **false until P5 presence** exists (`NullPresenceReader`). `whatsapp.enabled` is always false until P6.
- The base is cached per widget revision (any widget change busts it); availability has its own 8 s cache.

## Precedence and client overrides

Lowest to highest: **dashboard published config** < `data-*` attributes on the script tag < `window.ChatFeatureSettings` /
`ChatFeature('init', {...})` < runtime `ChatFeature('update', {...})`.

Rule: **client overrides may restrict or restyle, never expand.** Overridable: `theme.*`, `launcher.*`, `texts.*`, `defaultLocale`,
`greetings.{enabled,onPageLoad,delaySeconds,intervalMinutes,autoHideSeconds,dismissPolicy,showAgent}`, `features.{sounds,titleBadge}` (either direction),
`features.*` → `false` for any enabled feature (`poweredBy` included), a **subset** of the widget's already-enabled `categories`,
visitor prefill (`name,email,phone,meta`), `identityToken`, `openOnLoad`, and the init-only option `exposeMessageContent` (below). **Not overridable:** domains, `routing.*`, `hours.*`, `session.*`, enabling a feature the dashboard
disabled, adding categories. The server re-validates everything it receives (`startChat`, `setVisitor`, categories) — client-side filtering is cosmetic.
Client input is sanitised by whitelist in the loader (hex colours, https URLs, clamped numbers, control characters stripped, length caps); the loader's clamps are looser than the dashboard's (it only ever restyles).

`data-*` attribute map (kebab-case on `<script>`): `data-widget-key`, `data-position` (`left|right|bottom-left|bottom-right`), `data-offset-x`, `data-offset-y`, `data-locale`,
`data-theme-mode`, `data-theme-primary`, `data-theme-accent`, `data-theme-radius`, `data-launcher-style`, `data-launcher-label`,
`data-greetings` (`on|off`), `data-open-on-load` (`true|false`), `data-identity-token`, `data-categories` (comma-separated slugs), `data-z-index`.

**`exposeMessageContent`** (init option only: `ChatFeature('init', { exposeMessageContent: true })` or `ChatFeatureSettings`; not a `data-*` attribute; read once at mount, a later `update` cannot switch it on):
by default host handlers and DOM events receive only whitelisted metadata (see postmessage-protocol.md); with it, message text fields (`body`, `text`, `message`, `preview`, `comment`, each <= 2000 chars) are included too.

**`launcherLabel` text** (loader only): when the effective text locale differs from the widget's default locale and the host did not set `launcher.label`, the loader uses `texts[<locale>].launcherLabel` (<= 60 chars) as the pill label.
It can only come from client-supplied `texts` (the dashboard schema has no such key).

## Domain whitelist entries (`widget_domains.host`, `PUT /widgets/{ulid}/domains`)

- An entry is `host`, `host:port` or `*.host[:port]`, optionally prefixed `https://` (the default: dropped when stored) or `http://` (kept: the admin's explicit permission for a plain-http site, which then also admits https). Lower-cased, punycode, no path/userinfo/percent escapes; at most **255 characters** (the column width, prefix and port included); at most 50 entries per widget.
- A **bare entry admits https only.** Plain `http://` origins are admitted without the prefix only for development hosts: `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`.
- A wildcard is only the whole first label, needs a base that is not a public suffix (`*.com`, `*.co.uk`, `*.github.io` are rejected, built-in `PublicSuffixes` list, **partial**), cannot apply to an IP, matches subdomains at any depth but never the apex.
  An entry without a port matches the scheme's default port only; with a port, exactly that port. `Origin: null`, userinfo, paths and backslashes never match.
- The same list drives CORS on the public API and `frame-ancestors` on `/embed/{key}`, and is inlined as `allowedHosts` for the panel's own origin check (the panel itself arrives in P4). This app's own origin is always accepted on the public API (dashboard preview).

## Signed identity (HS256 JWT, verified by `IdentityTokenVerifier`)

Minted by the host website's backend with the widget's `identity_secret` (32 random bytes hex, stored encrypted, shown once by `POST /widgets/{ulid}/rotate-secret`; a rotation invalidates tokens signed with the old secret at once).

| Rule | Value |
|---|---|
| Header | `alg` must be `HS256` (`none`, `HS512`, `RS256`... refused before any signature work); token <= 8192 bytes |
| `iss` | **required**, must equal the widget's public key (`wk_…`) |
| `exp` | **required**, in the future and at most `chat.identity.max_lifetime_seconds` ahead (default **300 s**) |
| `iat`, `nbf` | optional; may not be more than 60 s in the future |
| `jti` | optional (string <= 128). When present the token is **single use per widget** until it expires (a second verification is refused as replayed). Without `jti` a token is reusable until `exp`. A forged token cannot burn a `jti`. |
| `sub` | optional, string (or int, stringified) <= 255 |
| `name` <= 120, `email` (valid, <= 190), `phone` (digits, spaces and `+ ( ) . -`, 3..40) | optional, type-checked, never coerced |
| `meta` | optional object, <= 20 entries, keys `[A-Za-z0-9_.-]{1,64}`, scalar values (strings <= 500), <= 4096 bytes as JSON |

The verifier exists and is tested in P3; the endpoint that consumes it (`POST /public/sessions`) arrives with P4. Unsigned identity (`setVisitor`) is accepted but marked **unverified**.

## Loader delivery and boot convention (3A <-> 3B)

`GET /w/{key}.js` returns, in one response: a prelude that registers the resolved boot config, then the loader bundle:

```js
(function(){var b=(window.__PNE_CHAT_BOOT__=window.__PNE_CHAT_BOOT__||{});b["wk_XXXX"]=<ResolvedBootConfig JSON>;})();
/*! pne-chat-loader v1 */ ...contents of public/widget/v1/loader.js ...
```
(JSON is escaped with `JSON_HEX_TAG | JSON_HEX_AMP`.) Headers: `Content-Type: application/javascript`, `X-Content-Type-Options: nosniff`, `ETag` (hash of the boot config without `generatedAt` plus the bundle fingerprint),
`Cache-Control: public, max-age=60, stale-while-revalidate=300`; an unknown/disabled/deleted widget answers `404` with a JS comment body and `no-store`.
The loader finds its widget key from `data-widget-key`, else the `/w/<key>.js` URL (`[A-Za-z0-9_-]{3,64}`), reads `window.__PNE_CHAT_BOOT__[key]`, and falls back to
`GET {scriptOrigin}/api/v1/public/widgets/{key}/config?locale=…` when absent or rejected (generic `/widget/v1/loader.js` + `data-widget-key`; failed loads retry after 2 s, 8 s, 30 s, and on `online`/a later `init`).
The bundle is built by `npm run build:widget` into `public/widget/v1/loader.js` (**git-ignored; the Docker build must run it**; first line `/*! pne-chat-loader v1 */`, which the builder's "is the bundle built?" probe looks for).
**Budget: 18 KB gzip** (`npm run size`, size-limit; was 15 KB in P3 and 16 KB in P3-P4; raised to 18 KB in P5 for the launcher alert; the P5 build is 16.44 KB). If the file is missing (dev), `/w/{key}.js` serves the prelude plus a console warning instead of failing and `/widget/v1/loader.js` a stub.
When the file exists, a web server that serves `public/` statically answers `/widget/v1/loader.js` itself (the Laravel route is only the fallback).

**Boot trust rules** (`window.__PNE_CHAT_BOOT__` is writable by any script on the host page): the loader accepts a boot object only when `key` equals the widget key, `api.appOrigin` is a bare origin
that **equals the origin the loader script was served from**, and `api.embed` is exactly `<appOrigin>/embed/<key>` with at most the `?preview=1` flag (no hash, no other query). Anything else is rejected and the loader falls back to the config endpoint.
The object the panel receives on `init` is **rebuilt** from validated fields (see postmessage-protocol.md).

The embed iframe page boots `resources/js/embed/main.tsx` (**stub until P4**) and reads its boot data from `window.__PNE_EMBED__ = { key, appOrigin, allowedHosts, preview, mode }` inlined by the Blade shell (`mode`: `launcher` | `inline` | `hosted`).
