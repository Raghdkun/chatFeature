# Changelog

> Status: living document; updated at the end of every phase gate.

All notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses phase tags `v0.N.0` until `v1.0.0` (P8).

## [Unreleased]

Nothing yet (P5 presence and notifications is next).

## [0.4.0] - 2026-10-01 (phase-4)

The live-chat core: a visitor starts a chat from the widget, every eligible online agent is offered it, the first to accept wins, and the two talk in realtime (typing, delivered/seen, images) until the chat is ended and rated. Built as a spine (shared schema/contracts), four parallel tracks, two independent review rounds with fix rounds, and a real-stack e2e suite.

### Added
- **Schema and domain** (`app/Domain/Chat`, `Visitors`, `Presence`): `visitors`, `visitor_sessions`, `conversations`, `conversation_events`, `conversation_agent_alerts` (offers), `messages` (per-conversation `seq`, idempotent `client_msg_id`), `attachments` (with `position`), `ratings`, `agent_presence`; the conversation state machine (`queued -> active -> ended -> closed`, `missed`, offline tickets as separate rows), `ConversationPolicy`, `Conversation::visibleTo`, 19 domain events, visitor-safe vs staff Data classes (generated TypeScript).
- **Routing**: offers go to active agents who serve the category, are online/away (heartbeat within 90 s) and under `max_concurrent_chats`; waves come from the widget's `config.routing.waves` (default online at 0 s, away after 20 s); first Accept wins through one guarded `UPDATE` (a re-accept by the winner is idempotent); queue timeout -> `missed` -> offline form -> offline ticket (claimed, answered by e-mail, closed); transfer to a colleague or a category with a reachability check (`409 no_agents`); deactivated or demoted agents' chats are requeued.
- **Public API** (`/api/v1/public`, bearer `vt_...` visitor tokens, no cookies): sessions (signed identity, token rotation with a 60 s overlap, `limits` for the panel), conversations, messages (`after_seq`), attachments (images only), receipts, typing, end/cancel, rating/skip, offline tickets, signed attachment URLs, broadcasting auth. **Management API**: conversations (filters, FULLTEXT/LIKE search shared with the history page, cursor paging), queue, claim, messages, attachments, receipts, typing, end/close/transfer, `transfer-targets`, CSV/JSON export (admin, audited), presence.
- **Jobs and commands**: `chat:expire-queued`, `chat:offer-waves`, `chat:close-idle`, `chat:close-unrated` (every minute), `chat:prune-visitor-sessions` (daily); a delayed `ExpireQueuedConversation`/`OfferNextWave` per chat (epoch-guarded). **The scheduler (`schedule:work` or cron) must run in production.**
- **Realtime (Reverb)**: channels `staff.{id}`, `presence-staff`, `conversation.{ulid}`, `admin` (authorised through the policy; visitors only through their own bearer endpoint), 19 events (`message.created` published immediately, the rest queued, `message.delivered`/`message.seen`, `conversation.missed`, `typing` fallback), failure isolation (a Reverb outage never breaks the HTTP request), redacted logs, allowed origins pinned to the app origin, `REVERB_*` env documented in `.env.example`, a real-socket smoke script (`npm run realtime:smoke`). The dashboard learns the Reverb address at runtime from the `realtime` shared prop.
- **Agent dashboard**: `/inbox` (queue with offer cards and countdown, my chats, unseen badges and tab title, conversation view with date separators, receipts, typing, lightbox, composer with attachments, end/transfer/copy transcript, presence selector with heartbeat), `/history` (admin: filters, search, ratings, paging, export), `/offline-tickets` (claim, reply, close); REST polling fallback when the websocket is down; phone drill-down layout.
- **Visitor panel** (inside the widget iframe): pre-chat, topic picker, queue with cancel, live chat (optimistic send with retry, receipts, typing, image attachments with lightbox, safe auto-linking), rating, offline form, closed screen, reconnect/visibility/gap sync, polling fallback, error boundary, host `startChat`/identity API, the compare-and-clear session protocol between tabs, English + Arabic built-in texts.
- **Tests**: PHPUnit and Vitest for every layer (counts in the Notes), a MySQL-gated concurrency suite (12 parallel claims -> exactly one winner), and a real-stack Playwright suite for the chat (`e2e/chat`, real Reverb per scenario, real customer-site page): lifecycle and routing, visitor resilience and identity, staff inbox and history, permission/IDOR matrices, channel authorisation with a real `pusher-js`, rate limits, polling-only mode, axe (light/dark, desktop/phone), 375/320 px, RTL, keyboard, performance, and the deck screenshots (`docs/screenshots/p4`).

### Changed
- `availability.online` is real now (presence-based, per category, following the widget's wave plan); the P3 builder preview runs the real panel on canned data.
- Visitor sessions: a rotated token's predecessor expires 60 s later; signing out revokes every session of that visitor; a chat start is limited per widget and network, after a cancel and by queued chats per network.
- `ConversationStaff` carries `queueExpiresAt`, `pageUrl`, `pageTitle`; `chat.offered` carries `ttlSeconds` (count down from the browser's own arrival time, never trust its clock).
- Signed attachment URLs live 240 minutes and are built from the configured app origin, not the request host.
- In mode 2 agents' names shown to visitors never fall back to an e-mail address.
- `/w/<key>.js` stays as in 0.3.0; the loader is 15.8 KB of its 16 KB budget (only about 200 bytes of headroom left).
- `BROADCAST_CONNECTION=reverb` in `.env.example`.

### Security (from the independent reviews)
- Token rotation no longer leaves the old token alive (stolen-token takeover of an open chat); `external_id` is compared case/accent-sensitively (binary collation); animated GIFs are refused and decoding never expands frames (pixel/memory bomb); the raw-byte markup scan that rejected genuine photos was dropped (the image is re-encoded, so polyglots do not survive); per-widget chat-start/offline-ticket budgets, a cancel cooldown and a per-network queue cap; a per-network limiter in front of every visitor route; a per-conversation attachment quota; `mailto:` links are encoded; staff `linkify` rejects credentialed URLs; the panel pins its API origin to the inlined app origin; CSV formula injection neutralised; visitor names are stripped of control characters in mail.

### Fixed (found by the e2e)
- Visitor panel: socket-close console error on every ended chat; a message burst unpinned the list; the older of two tabs lost its chat after a token rotation; Cancel sometimes ended on the offline form; a stale poll flipped a claimed chat back to queued; receipts of the visitor's own messages never refreshed after a poll.
- Backend: the loser of a simultaneous Accept got `403` instead of `409 already_claimed`; a MySQL deadlock on first-time verified sessions answered `500` (now retried); a hand-made list cursor answered `500` (now `422`); `DeadlockRetry` also catches nested-transaction deadlocks.
- Dashboard: sorting of conversations changed in the same second, stale ticks after a catch-up, focus loss on queued -> active, dialogs not returning focus, phone overflow of long names/tokens, blank lazy images, history filter bar overlap, contrast and target-size findings, `dir="auto"` on message text, delivery receipts never broadcast live (`message.delivered` added), attachment order inside a message (`position`).

### Known gaps / backlog
- Animated GIFs are refused (a chat image is a still); a visitor's socket and a deactivated agent's open socket keep receiving channel events until they disconnect (documented, P7: Reverb control API or channel epochs); server-written system lines ("X joined the chat") are English only; the inbox strings exist in English only (Arabic runs prove mirrored layout); captcha/proof-of-work hook for chat starts (P7); identity tokens expire (<= 5 min) before a lazily created session in a long-open page; no PII retention/erasure job; the phone connection banner is a compact variant only inside open conversations; `lang/ar.json` is partial.

## [0.3.0] - 2026-10-01 (phase-3)

Support categories, widgets, the embeddable loader and the builder. Developed in parallel with P2 and merged on `integrate/phase-2-3`.

### Added
- **Catalog and agents**: support categories (names per language, slug, order, active flag), staff management (create/edit/deactivate local agents, categories per agent, max concurrent chats), "My support categories" for agents. Agent categories are saved without range-locking the pivot table.
- **Widgets**: public key, draft vs published config (`config_version`), per-widget domain allow-list, greeting pool (weights, agent name/avatar, per locale), idle timeout (default 120 min) and queue timeout, take offline / back online, rotatable identity secret (HS256 JWT, `iss` = widget key, `jti`), builder with live preview (real loader in a mock host in three device frames, LTR/RTL, light/dark), embed-code tab (script, generic loader, iframe, REST).
- **Public delivery**: `/w/{key}.js` (boot config inlined, ETag), `/widget/v1/loader.js` (generic, reads `data-widget-key`), `/embed/{key}` (CSP `frame-ancestors` from the domain list), `GET /api/v1/public/widgets/{key}/config` and `/availability` behind `AuthorizeWidgetOrigin` (CORS echo for listed origins only, never cookies), per-widget and per-origin rate limits with CORS headers on 429.
- **Loader** (`resources/widget`, vanilla TypeScript, 15.65 KB gz of a 16 KB budget): Shadow-DOM launcher, greeting scheduler with the 3D flip to the agent face, dismiss policies, config precedence (`published < data-* < ChatFeatureSettings < runtime update`; policy fields are restrict-only), JS API and DOM events, versioned postMessage bridge with origin checks, handshake watchdog, full-screen panel on phones.
- Specs for the Phase 3 screens and the embeddable widget, proven together in real Chrome for the first time: `catalog/categories.spec.ts`, `catalog/agents.spec.ts` (+ a `@pizzasys` case: the Agents page when roles come from the Auth Portal), `widgets/widgets-list-and-builder.spec.ts` (every builder tab, hours validation, draft vs published, going live/offline, domains, identity secret, snippets, time zones), `widgets/preview.spec.ts` (the live preview runs the real loader in three device frames, live edits, static fallback), `widgets/loader-host.spec.ts` and `widgets/loader-origin.spec.ts` (the real widget on a customer-site page of another origin: shadow DOM, hostile host CSS, overrides, greetings and their dismiss policies, the handshake watchdog and the phone full-screen trap, the JS API, origin whitelist / CORS / CSP `frame-ancestors`, caching, no cookies), `widgets/loader-limits.spec.ts` (429 with CORS headers, unknown-key probing), `widgets/concurrency.spec.ts` (16 administrators configuring widgets in parallel), `widgets/escaping.spec.ts` (HTML in every administrator-typed value stays text), `widgets/views.spec.ts` (axe, 375px and Arabic/RTL for every new screen and the widget) and `screenshots/p3.spec.ts` (`docs/screenshots/p3/`, 25 screens x desktop/mobile x light/dark).
- New scenarios `p3-categories`, `p3-agents`, `p3-widgets`, `p3-host`, `p3-views`, `p3-views-rtl`, `p3-limits` (ports 8230-8239 and 8246; `seed: 'staff' | 'demo'` creates staff, categories and a demo widget), a static cross-origin "customer site" server (`e2e/support/host-server.mjs`, ports 8240-8245, started by `webServer`), an `api` / `adminApi` fixture for the management API, and `globalSetup` now builds `public/build` and the loader bundle itself when they are missing or older than the sources. See `docs/testing.md`.


### Changed
- `/w/<key>.js` now answers `403` (a console warning, no bubble, `Cache-Control: no-store`, `Vary: Referer`) to a page whose `Referer` is not on the widget's domain list or this installation's own origin. A request without a `Referer` is still served (the config is public; the chat iframe and every API call stay origin-checked). Before, an unlisted site still got the bubble and its greeting.
- Loader budget 15 KB -> 16 KB gz (boot-trust checks, per-origin handshake): the build is 15.65 KB. `.size-limit.json` and the loader build test follow.
- Domain list limit is 255 characters per entry everywhere (the client had 260); `resources/js/lib/limits.test.ts` reads the PHP rules so a drift fails a test.
- Replacing the domains, greetings or categories of a widget, and an agent's categories, now go through `App\Support\Database\DeadlockRetry`: up to 6 attempts with a short random, growing pause when MySQL aborts the transaction (1213/40001 or lock timeout 1205). Three immediate retries still lost 2 of 480 parallel saves.

### Fixed (found by the P3 e2e)
- Widget builder: a widget whose time zone was saved under a legacy name (`Asia/Calcutta`, `US/Pacific`; the settings accept them) could never save its draft again (`422 The timezone field must be a valid timezone`): `WidgetConfigValidator` validated the mirrored `hours.timezone` with `timezone:all` while `UpdateWidgetRequest` uses `all_with_bc`. Both accept the legacy names now.
- Domains tab: every scheme prefix was refused, although the server keeps `http://` (the admin's explicit permission for a site served without https) and drops `https://`; there was no way to allow such a site from the dashboard. The tab keeps `http://` and drops `https://` now (help text and error copy updated).
- Accessibility (axe best-practice): headings jumped from `h1` to `h3` on `/categories`, `/widgets` and every builder tab (section and row titles are `h2` now), and the builder had two `main` landmarks because the live preview's fake site (an `<iframe srcdoc>`) used `<main>` / `<header>`.

- `WidgetDeliveryTest::test_conditional_requests_and_etag_changes` failed when it ran in the half minute before 09:00 or 17:00 UTC on a weekday (the widget's availability flips at the default opening hours while `travel(30)` crosses the instant); the clock is pinned now.

### Known, not fixed
- The builder preview shows `Chat` as the panel's accessible name after the `title` text is emptied; the saved widget gets the server's English default `Support`.
- "Take widget offline ... right away" holds for the server; a browser or CDN that already has `/w/<key>.js` keeps using it for `max-age=60` + `stale-while-revalidate=300`.
- The launcher's own label text key (`launcherLabel`) is not part of the server's `WidgetTexts`; the loader clamps ranges more loosely than the server; category description/icon/colour are not forwarded to the chat panel yet (P4); the public-suffix list used for wildcard domains is partial; `SupportCategoriesPageController` is gated client-side only; `lang/ar.json` is partial.

### Notes
- Review: read-only reviewer passes over the backend, the loader and the dashboard, a dedicated front-end/back-end contract audit and a manual security pass; every finding was fixed (for example `useFlashToast` mounted twice). The `/security-review` and `/simplify` skills cannot run on this machine (they shell out to the blocked system git).

## [0.2.0] - 2026-10-01 (phase-2)

External sign-in through the pizzasys Auth Portal (setup mode 2). Developed in parallel with P3, reviewed and integrated together with it: `v0.2.0` and `v0.3.0` are tags on the same commit.

### Added
- **Setup wizard, mode 2**: portal environment (production and an optional testing one), service client name + token (encrypted), live `token-verify` probe, a verified portal administrator before finishing, role mapping (admin permission `chat.admin`, agent permission `chat.agent`, super roles default `super-admin`), optional NATS.
- **`PizzasysDriver`**: server-side login (the portal token never reaches the browser), `token-verify` on a 60 s cache with single-flight and a 15 s negative cache, circuit breaker, shadow users keyed by `(environment, sub)`, roles derived only from the portal (`PizzasysRoleResolver`), `EnsureSessionIsValid` revocation, degrade with a grace window then `503 auth_unavailable`, three login throttles (per email + address, per address, per email), best-effort upstream `logout` of the same token, `refresh-token` never called.
- **Environments**: `auth_environments` (production / testing), Settings > Auth (edit, connection test with a verdict that survives a reload, role mapping, active-environment switch that needs admin credentials on the target and signs everybody out), `chat:auth:switch-env` / `set-env` / `test` / `reactivate` / `prune-*` break-glass commands.
- **NATS consumer** `chat:auth:consume-nats`: durable consumer on `auth.v1.>`, stream ensured, de-duplicated on the envelope id, routing by CloudEvent `type`, dead-letter file, TLS verification, never trusts `user.updated.from`, never logs payloads. A NATS outage only lengthens the revocation lag to the verify TTL.
- `docs/pizzasys-findings.md`: empirical behaviour of a local clone (tokens never expire, bad user token = HTTP 200 `active:false`, bad service credential = 401, `refresh-token` revokes every token, `super-admin` carries no `chat.*` permission, `user.updated` leaks a hash); `docs/contracts/auth-pizzasys.md`.
- Specs for auth mode 2 against a real local pizzasys instance (the throwaway harness, started and stopped by `e2e/global-setup.ts`): the whole wizard in Auth Portal mode (`install/wizard-pizzasys.spec.ts`), sign-in/roles/revocation/role changes (`auth/login-pizzasys.spec.ts`), a portal outage with grace, 503 and recovery (`auth/portal-outage.spec.ts`, own `pizzasys-outage` project, runs last), Settings > Auth (`settings/auth-settings.spec.ts`), plus axe, 375px and RTL coverage of every mode-2 screen and `docs/screenshots/p2/` deck screenshots. New scenarios `fresh-pizzasys`, `installed-pizzasys`, `settings-pizzasys`, `wizard-views-pizzasys(-rtl)`, `installed-pizzasys-rtl`. The P1 wizard spec now asserts that the Auth Portal option is selectable. See `docs/testing.md`.


### Changed
- The sign-in page and the profile name the portal only when it is a public DNS name (`https://<host>`); a loopback/private portal (the local harness, a Docker service name) is never disclosed and never linked (`PortalLabel`). The e2e specs assert exactly that for the harness.
- Changing the portal address, service name or TLS verification (or the NATS address) requires re-entering the stored token (`SecretReentry`), and saving a connection change on the live environment first runs a connection test: a pair the portal refuses is not saved, so nobody is locked out. Display name, role mapping and NATS block edits keep the stored token.
- Setup-token takeover guard (loopback-only rule, per-session verification, throttling), SSRF guard on every outbound portal/NATS address (`OutboundUrlGuard`, `PORTAL_ALLOW_PRIVATE_HOSTS` for local development), `Http::preventStrayRequests()` in the shared test case.

### Fixed (found by the mode-2 e2e)
- A rejected Auth Portal form (wizard or Settings > Auth) flashed the typed service/NATS tokens into the session store as "old input"; they are excluded from flashing now (`bootstrap/app.php`).
- Inertia's local DevTools recorded the typed `service_token` / `nats_token` in clear text under `storage/inertia-devtools`; both keys are redacted now.
- Settings > Auth write endpoints answered 422 instead of 404 in mode 1 when the payload was invalid; the 404 comes first now.
- Auth Portal mode: Settings still linked to the Security page (a 404) and showed an editable profile form (saving answered 404) and "Delete account"; the Security link is gone and the profile is read-only with a pointer to the portal.

### Notes
- Verified against a local throwaway clone of the real pizzasys, not a production instance; the NATS part has never run against a real NATS server (Docker was not running). The public pizzasys repo's seeder creates a `super-admin` account with a known password: confirm it does not exist on the real instance.

## [0.1.0] - 2026-09-30 (phase-1)

Install gate, setup wizard, settings, mode-1 auth, role-aware shell, e2e suite.

### Added
- **Install domain**: file-backed `InstallState` (state + atomic `installed.lock`, 0600), `InstallGate` (web -> `/setup`, API -> 503 `not_installed`), `EnsureNotInstalled` (`/setup*` 404 forever; JSON callers get `{"status":"installed"}`), resumable flock-guarded `InstallRunner` with eight steps, fail-closed one-time `SETUP_TOKEN` guard (`hash_equals`, per-session, throttled), `InstallAwareConfigProvider` (session/cache/queue/broadcast forced to file/file/sync/null until installed). No database access before `migrate`.
- Commands: `chat:install` (non-interactive, `INSTALL_*` env), `chat:bootstrap-secrets` (APP_KEY, Reverb, VAPID, setup token), `chat:install:reset` (local only).
- **Settings** (typed registry, encrypted values, cached, 2 s per-process memo) and **audit log** with secret redaction; users get `role`, `is_admin`, `is_agent`, `is_active`, `auth_source`, ... (additive migration).
- **Auth layer**: `AuthDriver`/`RoleResolver` contracts, `AuthModeManager`, `FortifyDriver`, `LocalRoleResolver`, admin `Gate::before`, `EnsureSessionIsValid` / `EnsureChatAccess` (aliases `session.valid`, `chat.access` for API groups), registration gated by settings, staff API tokens scoped to `staff` with expiry and revocation on deactivation.
- **Frontend**: setup wizard (7 screens, resumable, Back), role-aware sidebar from the nav registry, `useTrans`/`useDirection`, RTL support, login variants (starter kit / Auth Portal), role-aware dashboard stub, generated Wayfinder routes and PHP-generated TS types for the wizard.
- `TRUSTED_PROXIES` (config `chat.trusted_proxies`) for running behind Caddy; `SANCTUM_EXPIRATION_MINUTES`.
- Contracts: setup wizard, auth driver, widget config, postMessage protocol, REST shapes, realtime events; `docs/pizzasys-findings.md` (empirical pizzasys behaviour).
### Added (e2e)
- Playwright e2e suite (`npm run e2e`, `e2e:headed`, `e2e:screenshots`): real Chrome, `desktop` and `mobile` (Pixel 7) projects, one throwaway Laravel server + `chatfeature_e2e*` database + private storage directory per scenario (`playwright.config.ts`, `e2e/`). Specs cover the install gate, the full setup wizard (environment check, validation, resume, Back, install, sign-in, 404 after the lock), the setup-token takeover guard (locked environment check, wrong/right token, per-session verification, throttling, token never in a response), sign-in/out, the role-aware shell (admin vs agent vs no access), settings, axe (WCAG 2.x A/AA, light + dark, every wizard screen), 375px layouts and Arabic/RTL. `E2E_SCREENSHOTS=1` writes full-page deck screenshots to `docs/screenshots/p1/` (desktop + mobile, light + dark). See `docs/testing.md`.

### Fixed (found by e2e)
- Setup wizard: "Check again" on the environment screen reached with Back threw the user forward to the server's step; only saved forms (non-GET visits) reset the client-side screen override now.
- Login: the dedicated "No chat access" notice never showed with the real backend (it looked for a `reason` prop / `access` error the backend did not send). The backend now flashes `reason=no_chat_access` for the rejected sign-in and for sessions ended by `EnsureChatAccess`, the login page passes it on, and the notice replaces the duplicate inline email error.
- Landmarks (axe): the auth/setup layouts (login, forgot password, the wizard) render their root as `<main>`; they had no main landmark.
- Contrast (axe, serious): `--destructive-foreground` (error copy) is red-700 in the light theme (4.2:1 on the tinted alert background before), and the "Delete account" warning box uses `text-red-700`.


### Fixed (code review)
- Staff are never gated on email verification; settings memo no longer stale in queue workers; undecryptable settings are reported; the wizard cannot take over an existing account; 404 is no longer read as "installed"; state file is created 0600; idle timeout range is 5-10080 minutes everywhere.

### Notes
- Gate: `composer ci:check` green (pint, PHPStan L7, 236 PHPUnit, `vp check`, `tsc`, 135 Vitest), 132 Playwright specs green, production build OK. `/code-review` (10 findings fixed) and a manual security pass; the `/security-review` and `/simplify` skills could not run because they shell out to the blocked system git.

## [0.0.0] - 2026-09-30 (phase-0)

Scaffold, tooling and project memory. No application logic yet.

### Added
- Project scaffolded with `laravel new --react --database=mysql --phpunit` (Laravel 13.34, Inertia 3, React 19, Tailwind 4, shadcn/ui, Fortify, Wayfinder, Vite 8 via vite-plus).
- `laravel/sanctum` 4.3, `laravel/reverb` 1.12, `laravel-notification-channels/webpush` 13.0, `intervention/image` 4.3 and `basis-company/nats` 1.2; dev: `knuckleswtf/scribe` 5.11, `laravel/boost` 2.10.
- `spatie/laravel-data` 4.23 + `spatie/laravel-typescript-transformer` 3.3: PHP `#[TypeScript]` Data classes generate `resources/js/types/generated.d.ts` (`composer types:generate`). First DTO: `App\Data\Auth\AuthUserData`.
- Echo on the JS side (`@laravel/echo-react`, `laravel-echo`, `pusher-js`); `zod`; dev: `@playwright/test`, `@axe-core/playwright`, `size-limit`, `jsdom`, `msw`.
- Per-context service providers (`app/Providers/*ServiceProvider.php`), `App\Support\RouteFiles` glob loader (`routes/web`, `routes/api/{management,public}`, `routes/webhooks`), bearer-only `widget` middleware group, sidebar nav registry (`resources/js/nav`) with a first Vitest test.
- All additional shadcn components (tabs, table, switch, slider, popover, command, textarea, scroll-area, calendar, chart, radio-group, progress, accordion, alert-dialog, hover-card, pagination, drawer, resizable, empty, kbd, button-group, input-group).
- `docker/compose.dev.yml` (Mailpit; NATS/OpenWA/MySQL/Redis behind profiles); `npm test` in `composer ci:check`; scripts `test`, `test:watch`, `e2e`, `size`.
- `CLAUDE.md` (imports Boost's `AGENTS.md`), `README.md` roadmap, `docs/*.md`, `docs/contracts/*`.

### Changed
- `guzzlehttp/guzzle` pinned to `^7.9` (guzzle 7.15 / psr7 2.13). Laravel 13.34 resolves guzzle 8 / psr7 3 by default, which Reverb 1.12 and `pusher/pusher-php-server` do not support.
- `.gitignore` no longer ignores `CLAUDE.md`, `AGENTS.md`, `boost.json` (project memory is versioned).
- `.env` / `.env.example`: MySQL `chatfeature` (dedicated local DB), Redis for cache/queue/session, app name "PNE Chat".
- `config/sanctum.php`: `(string)` cast on `env()` to satisfy PHPStan level 7.
- `command.tsx` (shadcn) adapted to the kit's `dialog.tsx` (no `showCloseButton`); formatter ignores docs/generated files.

### Notes
- Resolved versions: framework 13.34.0, fortify 1.40.0, inertia-laravel 3.4.0, guzzle 7.15.5, psr7 2.13.1, reverb 1.12.0, sanctum 4.3.3.
- Gate for P0 = automated checks only (`composer ci:check`: pint, phpstan L7, 40 PHPUnit tests, `vp check`, `tsc`, Vitest) plus MySQL migrate and a production build; there is no application logic to code-review yet.
- Machine notes (system git blocked by Xcode licence, `install:api` runs migrations, TTY needed by `install:broadcasting`) are in `CLAUDE.md` "Gotchas".
