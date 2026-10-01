# Contracts

> Status: living. Written by the orchestrator **before** a phase fans out to parallel tracks. A track
> may *read* every contract and may only *change* one through the orchestrator (open a note in your
> hand-back report; the orchestrator edits the contract and re-syncs the other tracks).

| Contract | Needed by | Status |
|---|---|---|
| [inertia-shared-props.md](inertia-shared-props.md) | P1 (all tracks) | written (P0); implemented in P1 |
| [install-steps.md](install-steps.md) | P1, P2 | written (P0); implemented in P1/P2 |
| [setup-wizard.md](setup-wizard.md) | P1 (1A backend, 1B frontend, 1C e2e) | written (P1); implemented in P1 (mode-2 screens: see auth-pizzasys.md) |
| [auth-driver.md](auth-driver.md) | P1, P2 | written (P0); **implemented in P1/P2, reviewed**; additive P2 section added |
| [auth-pizzasys.md](auth-pizzasys.md) | P2 (2A, 2B, 2C) | written (ahead of P2); **implemented in P2, reviewed and hardened**; "Implemented-truth notes" added |
| [ownership.md](ownership.md) | every phase | written (P0), extended per phase |
| [dashboard-pages-p3.md](dashboard-pages-p3.md) | P3 (3A, 3C) | written (ahead of P3); **implemented in P3, reviewed** (live vs draft table added) |
| [widget-config.md](widget-config.md) | P3 (3A, 3B, 3C), P4 (4D) | written (ahead of P3); **implemented in P3, reviewed** (rewritten to the implemented truth) |
| [postmessage-protocol.md](postmessage-protocol.md) | P3 (3B), P4 (4D) | written (ahead of P3); **host side implemented in P3, reviewed**; the panel side is P4 (stub today) |
| [rest-shapes.md](rest-shapes.md) | P3, P4 | conventions + P3 endpoints **implemented in P3, reviewed**; P4 chat endpoints written (plan) |
| [chat-ui-p4.md](chat-ui-p4.md) | P4 (4C, 4D) | written (ahead of P4) |
| [realtime-events.md](realtime-events.md) | P4, P5, P6 | written (ahead of P4) |
| [chat-data-p4.md](chat-data-p4.md) | P4 (4A, 4B, 4C, 4D) | **implemented by the P4 spine**: tables, enums, state machine, policy, visitor tokens, Data classes, domain events, shared TypeScript helpers |

## Rules

1. **PHP is the source of truth for shared shapes.** Define payloads as `spatie/laravel-data` classes in
   `app/Data/<Context>/` with `#[TypeScript]`; run `composer types:generate` and import the generated
   `App.Data.*` types from `resources/js/types/generated.d.ts`. Never hand-copy a shape into TypeScript.
2. **Public identifiers are ULIDs or `public_key`s.** Integer primary keys never appear in a payload that
   leaves the server (visitor-facing or API). Staff-only Inertia props may use integer user ids.
3. **Additive changes only inside a phase.** New optional fields are fine; renaming/removing a field
   needs an orchestrator-approved contract change.
4. **Tests assert the contract.** Every Data class that crosses a boundary has a feature test that
   fetches it through the real endpoint/page and checks the key set.

## Implemented-truth changelog

Where the shipped code differs from (or sharpens) what was written before the phase, the contract was updated to the code. One line per contract.

- **widget-config.md** (P3): text keys `closeChat`, `unread`, `dismiss` added (loader aria-labels); `launcherLabel` is a loader-only text read from client overrides; `exposeMessageContent` init option; `HolidayData.label` is always a string; boot config gains `locale`, category `description/icon/color` and `availability.categories`;
  domain entries may carry `http://`, a bare entry admits https only, wildcards on public suffixes are rejected, entries <= 255 chars, locales <= 12 chars; the five mirrored columns are authoritative; out-of-range numbers are rejected, never clamped;
  identity JWT requires `iss` = public key and `exp` <= `chat.identity.max_lifetime_seconds` (300 s), optional single-use `jti`; loader budget is **16 KB gzip** (15.65 KB built); boot-trust rules (`appOrigin` = loader script origin, embed URL `/embed/<key>` with at most `?preview=1`).
- **postmessage-protocol.md** (P3): `init:result` ack (or the panel's first `state`/`session`), 1 s re-send and 10 s timeouts that close the panel and unlock scrolling, loader `ready` event vs the panel's `ready` message and `getState().panelReady`; loader-owned vs panel-owned events with a payload whitelist
  (`exposeMessageContent` opt-in); DOM events do not bubble and are not composed, on `document` and `window`; `init.boot` is rebuilt (no raw pass-through) and `overrides` pre-restricted; session storage shape `{token, expiresAt, id}` bound to the identity;
  iframe sandbox attributes; Escape split (host document closes, the panel must send `close`); config fetch retry 2/8/30 s; **no `draft` command on the host API** (builder preview uses a same-origin relay + `update`, or reboots the host page); loader marker `/*! pne-chat-loader v1 */`.
- **rest-shapes.md** (P3): error-code table (`widget_not_found`, `origin_not_allowed`, `category_in_use`, `slug_taken`, `managed_by_auth_portal`, `cannot_deactivate_self`, `not_an_agent`, `auth_mode_unavailable`, `auth_unavailable`, `server_error`, `rate_limited`...); public config/availability details (envelope, locale matching, ETag/304, preflight, 429 CORS rule, limiter budgets);
  response shapes of the draft/domains/greetings/categories/me-categories endpoints; lists carry `meta.next_cursor: null`; public keys are `wk_` + 20 `[a-z0-9]`; `not_installed` is a bare `{"error":...}`.
- **dashboard-pages-p3.md** (P3): live vs draft table (config JSON = draft/publish; settings columns, greetings, domains, category links are live; `is_enabled` is its own confirmed action); `POST /agents` has no `is_admin`; `CategoryData` has no `widgets` list (only `widgets_count`); support-categories page gate (any staff; `/me/categories` needs `is_agent`);
  `409 not_an_agent`, `cannot_deactivate_self`; `is_agent=false` clears categories.
- **auth-pizzasys.md** (P2): token re-entry rule (422 on `service_token` / `nats_token`, dotted wizard keys), pre-flight `TestPortalConnection` before saving the ACTIVE environment (`errors.connection|base_url|service_token`, `checks[]`), role mapping cannot remove the saver's own admin access, activation error codes, wizard/settings throttles,
  `user.deleted` deactivates only the identity (`chat:auth:reactivate`), `portalUrl` is a public `https://host` or null, outbound URL guard (`PORTAL_ALLOW_PRIVATE_HOSTS`), NATS TLS verification (`NATS_TLS_CA_FILE`), setup token skipped only for `APP_ENV=local` + loopback peer, `login_throttle`, one live identity per (user, environment), `service_credential_rejected` health flag.
- **auth-driver.md** (P2): `SessionVerdict::Unavailable` and the `503 auth_unavailable` degrade with its exemptions (not the role mapping), middleware aliases `session.valid` / `chat.access` / `admin`, one live identity per (user, environment), login throttles, `chat:install` exists.
- **realtime-events.md / rest-shapes.md / dashboard-pages-p3.md** (P4 spine): `conversation.ended.endedBy` may be `system`, `conversation.closed.reason` may be `cancelled` (the visitor left the queue); `category_in_use` now guards queued **and** active conversations through the real `ConversationCategoryUsageChecker`;
  every payload has a PHP class (`app/Data/Chat`, `app/Data/Chat/Events`), see [chat-data-p4.md](chat-data-p4.md).
