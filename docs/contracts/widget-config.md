# Widget config schema

> Status: contract v1 (written before P3). Owners: P3 3A (PHP `WidgetConfig` Data + validation), 3B (loader), 3C (builder UI),
> P4 4D (embed panel). The PHP class is the source of truth (`app/Domain/Widgets/Data/WidgetConfigData.php`, `#[TypeScript]`);
> this document defines the shape and defaults it must implement.

A widget has a **published** config (`widgets.config`, versioned by `config_version`) and a **draft** (`widgets.draft_config`).
Greetings, domains and category links live in their own tables and are merged into the *resolved boot config* below.

## Config object (`v: 1`)

```jsonc
{
  "v": 1,
  "defaultLocale": "en",
  "localeDetect": true,                       // pick visitor browser locale if a texts block exists for it
  "theme": {
    "mode": "auto",                           // "auto" | "light" | "dark"
    "primary": "#0f766e", "primaryText": "#ffffff",
    "accent": "#f59e0b", "surface": "#ffffff", "text": "#0f172a",
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
    "icon": "chat",                           // "chat" | "help" | "sparkle" | "custom"
    "iconUrl": null, "label": "Chat with us", // label only for style "pill"
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
      "thanks": "Thanks for your feedback!", "startNewChat": "Start a new chat", "poweredBy": "Powered by PNE Chat"
    }
  },
  "features": {
    "attachments": true, "rating": true, "sounds": true, "preChat": true,
    "whatsapp": false,                        // only effective if the widget has a connected WhatsApp session
    "offlineForm": true, "titleBadge": false, "endChatByVisitor": true, "poweredBy": true
  },
  "preChat": {
    "fields": {
      "name":  { "enabled": true,  "required": true  },
      "email": { "enabled": true,  "required": false },
      "phone": { "enabled": false, "required": false }
    },
    "consentText": null                       // when set, an unchecked consent checkbox gates "Start chat"
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
    "schedule": [ { "day": 1, "start": "09:00", "end": "17:00" } ],   // day 0=Sun..6=Sat, multiple ranges per day allowed
    "holidays": [ { "date": "2026-12-25", "label": "Christmas" } ]
  },
  "routing": {
    "waves": [ { "afterSeconds": 0, "statuses": ["online"] }, { "afterSeconds": 20, "statuses": ["away"] } ],
    "wakeOfflineViaPush": false,
    "queueTimeoutSeconds": 90
  },
  "session": { "idleTimeoutMinutes": 120 }    // mirrors widgets.idle_timeout_minutes (admin-configurable, default 120)
}
```

All colour fields must be 3/6/8-digit hex. All URLs must be `https:` (or same-origin relative). Validation is strict:
unknown keys are rejected on write, out-of-range numbers are clamped or rejected with a field-level error.

## Greeting pool item (table `widget_greetings`)

`{ id (ulid), body (text, no length cap besides 2000), agentName?, agentAvatarUrl?, locale? (null = any), weight (int>=1, default 1), isActive }`.
`body` is plain text (rendered as text, never HTML). Selection: weighted random among active items matching the visitor locale
(fall back to locale-less items), never the same item twice in a row.

## Resolved boot config (what `/w/{key}.js` inlines and `GET /api/v1/public/widgets/{key}/config` returns)

```jsonc
{
  "v": 1, "key": "wk_…", "configVersion": 12, "generatedAt": "2026-09-30T12:00:00Z",
  "api": { "base": "https://chat.example.com/api/v1/public", "embed": "https://chat.example.com/embed/wk_…", "appOrigin": "https://chat.example.com" },
  "config": { /* the object above, minus policy-only fields not needed client-side (routing.*, session.idleTimeoutMinutes stay server-side) */ },
  "greetings": [ { "id": "…", "body": "…", "agentName": "Sara", "agentAvatarUrl": "https://…", "locale": null, "weight": 2 } ],
  "categories": [ { "slug": "billing", "label": "Billing" } ],            // already filtered to this widget's enabled categories, ordered
  "availability": { "online": true, "openNow": true, "nextOpenAt": null, "whatsapp": { "enabled": false } }
}
```

## Precedence and client overrides

Lowest to highest: **dashboard published config** < `data-*` attributes on the script tag < `window.ChatFeatureSettings` /
`ChatFeature('init', {...})` < runtime `ChatFeature('update', {...})`.

Rule: **client overrides may restrict or restyle, never expand.** Overridable: `theme.*`, `launcher.*`, `texts.*`, `defaultLocale`,
`greetings.{enabled,onPageLoad,delaySeconds,intervalMinutes,autoHideSeconds,dismissPolicy,showAgent}`, `features.{sounds,titleBadge,poweredBy}`
(to `false` only for `poweredBy`), `features.*` → `false` for any enabled feature, a **subset** of the widget's already-enabled `categories`,
visitor prefill (`name,email,phone,meta`). **Not overridable:** domains, `routing.*`, `hours.*`, `session.*`, enabling a feature the dashboard
disabled, adding categories. The server re-validates everything it receives (`startChat`, `setVisitor`, categories) — client-side filtering is cosmetic.

`data-*` attribute map (kebab-case on `<script>`): `data-widget-key`, `data-position`, `data-offset-x`, `data-offset-y`, `data-locale`,
`data-theme-mode`, `data-theme-primary`, `data-theme-accent`, `data-theme-radius`, `data-launcher-style`, `data-launcher-label`,
`data-greetings` (`on|off`), `data-open-on-load` (`true|false`), `data-identity-token`, `data-categories` (comma-separated slugs), `data-z-index`.
