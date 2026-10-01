# Changelog

> Status: living document; updated at the end of every phase gate.

All notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses phase tags `v0.N.0` until `v1.0.0` (P8).

## [Unreleased]

### Added (e2e, P3: catalog, widgets, loader)
- Playwright specs for the Phase 3 screens and the embeddable widget, proven together in real Chrome for the first time: `catalog/categories.spec.ts`, `catalog/agents.spec.ts` (+ a `@pizzasys` case: the Agents page when roles come from the Auth Portal), `widgets/widgets-list-and-builder.spec.ts` (every builder tab, hours validation, draft vs published, going live/offline, domains, identity secret, snippets, time zones), `widgets/preview.spec.ts` (the live preview runs the real loader in three device frames, live edits, static fallback), `widgets/loader-host.spec.ts` and `widgets/loader-origin.spec.ts` (the real widget on a customer-site page of another origin: shadow DOM, hostile host CSS, overrides, greetings and their dismiss policies, the handshake watchdog and the phone full-screen trap, the JS API, origin whitelist / CORS / CSP `frame-ancestors`, caching, no cookies), `widgets/views.spec.ts` (axe, 375px and Arabic/RTL for every new screen and the widget) and `screenshots/p3.spec.ts` (`docs/screenshots/p3/`, 25 screens x desktop/mobile x light/dark).
- New scenarios `p3-categories`, `p3-agents`, `p3-widgets`, `p3-host`, `p3-views`, `p3-views-rtl` (ports 8230-8239; `seed: 'staff' | 'demo'` creates staff, categories and a demo widget), a static cross-origin "customer site" server (`e2e/support/host-server.mjs`, ports 8240-8245, started by `webServer`), an `api` / `adminApi` fixture for the management API, and `globalSetup` now builds `public/build` and the loader bundle itself when they are missing or older than the sources. See `docs/testing.md`.

### Fixed (found by the P3 e2e)
- Widget builder: a widget whose time zone was saved under a legacy name (`Asia/Calcutta`, `US/Pacific`; the settings accept them) could never save its draft again (`422 The timezone field must be a valid timezone`): `WidgetConfigValidator` validated the mirrored `hours.timezone` with `timezone:all` while `UpdateWidgetRequest` uses `all_with_bc`. Both accept the legacy names now.
- Domains tab: every scheme prefix was refused, although the server keeps `http://` (the admin's explicit permission for a site served without https) and drops `https://`; there was no way to allow such a site from the dashboard. The tab keeps `http://` and drops `https://` now (help text and error copy updated).
- Accessibility (axe best-practice): headings jumped from `h1` to `h3` on `/categories`, `/widgets` and every builder tab (section and row titles are `h2` now), and the builder had two `main` landmarks because the live preview's fake site (an `<iframe srcdoc>`) used `<main>` / `<header>`.

- `WidgetDeliveryTest::test_conditional_requests_and_etag_changes` failed when it ran in the half minute before 09:00 or 17:00 UTC on a weekday (the widget's availability flips at the default opening hours while `travel(30)` crosses the instant); the clock is pinned now.

### Known, not fixed (found by the P3 e2e)
- `/w/<key>.js` inlines the boot config, so a site that is NOT on the widget's domain list still gets the bubble and its greeting (only the generic loader asks the config endpoint, which answers `403 origin_not_allowed`); the chat iframe (CSP `frame-ancestors`) and every API call are refused there. Decide whether the script endpoint should check the `Referer`.
- The builder preview shows `Chat` as the panel's accessible name after the `title` text is emptied; the saved widget gets the server's English default `Support`.
- "Take widget offline ... right away" holds for the server; a browser or CDN that already has `/w/<key>.js` keeps using it for `max-age=60` + `stale-while-revalidate=300`.

### Added (e2e, mode 2 / Auth Portal)
- Playwright specs for auth mode 2 against a real local pizzasys instance (the throwaway harness, started and stopped by `e2e/global-setup.ts`): the whole wizard in Auth Portal mode (`install/wizard-pizzasys.spec.ts`), sign-in/roles/revocation/role changes (`auth/login-pizzasys.spec.ts`), a portal outage with grace, 503 and recovery (`auth/portal-outage.spec.ts`, own `pizzasys-outage` project, runs last), Settings > Auth (`settings/auth-settings.spec.ts`), plus axe, 375px and RTL coverage of every mode-2 screen and `docs/screenshots/p2/` deck screenshots. New scenarios `fresh-pizzasys`, `installed-pizzasys`, `settings-pizzasys`, `wizard-views-pizzasys(-rtl)`, `installed-pizzasys-rtl`. The P1 wizard spec now asserts that the Auth Portal option is selectable. See `docs/testing.md`.

### Fixed (found by the mode-2 e2e)
- A rejected Auth Portal form (wizard or Settings > Auth) flashed the typed service/NATS tokens into the session store as "old input"; they are excluded from flashing now (`bootstrap/app.php`).
- Inertia's local DevTools recorded the typed `service_token` / `nats_token` in clear text under `storage/inertia-devtools`; both keys are redacted now.
- Settings > Auth write endpoints answered 422 instead of 404 in mode 1 when the payload was invalid; the 404 comes first now.
- Auth Portal mode: Settings still linked to the Security page (a 404) and showed an editable profile form (saving answered 404) and "Delete account"; the Security link is gone and the profile is read-only with a pointer to the portal.

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
