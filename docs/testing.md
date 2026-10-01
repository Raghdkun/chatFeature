# Testing

> Status: partially live. PHP checks, `vp`/`tsc`, Vitest, size-limit (`npm run size`) and the Playwright e2e suite (install wizard, sign-in, shell, a11y, responsive, RTL, auth mode 2 against a real local pizzasys, and the P3 screens: categories, agents, widgets, the builder with its live preview, and the real widget on a cross-origin host page) are live; k6 is planned.

## Test layers

| Layer | Tool | Covers | Status |
|---|---|---|---|
| PHP style | Pint (`pint --test`) | Code style | available |
| PHP static analysis | Larastan / PHPStan (`phpstan analyse`) | Types | available |
| PHP feature/unit | PHPUnit via `artisan test` (SQLite for speed) | Actions, controllers, gates, drivers | available |
| MySQL-only tests | PHPUnit on MySQL in CI | Concurrent-accept race, unique-NULL trap | planned P4 |
| Frontend lint/format | `vp check` (`npm run check`) | TS/React lint + format | available |
| Types | `tsc --noEmit` (`npm run types:check`) | TypeScript | available |
| Frontend unit | Vitest (+ MSW until backend merges) | Wizard flow, login/shell, i18n; later: loader precedence, fake-timer greeting scheduler, reduced motion, postMessage origin checks | available (`npm test`) |
| Bundle budget | size-limit (`npm run size`) + `widgets/loader-host.spec.ts` | Loader <= 16 KB gz | available |
| E2E | Playwright on real Google Chrome (desktop 1280x800 + Pixel 7 profiles) | Install wizard, setup token, sign-in, role-aware shell, axe, 375px, RTL; mode 2: portal wizard, portal sign-in, revocation, role changes, outage, Settings > Auth; P3: categories, agents, widgets list, builder (every tab, hours, draft vs published, live preview), the real loader on a cross-origin host page (shadow DOM, hostile CSS, overrides, greetings, handshake watchdog, JS API, origin/CORS/CSP, caching, no cookies); later: two-browser chat lifecycle | P1 + P2 + P3 available (`npm run e2e`), P4/P8 planned |
| Integration | Docker `nats -js`, real pizzasys clone, real OpenWA image | NATS idempotency/deactivation, token TTL, QR to ready, recorded fixtures | pizzasys clone: used by the mode-2 e2e (no NATS); NATS + OpenWA planned P6 |
| Security matrices | PHPUnit/Playwright | Channel-auth, visitor IDOR, agent isolation (403), CORS/CSP/origin, upload abuse (spoof/oversize/EXIF/SVG) | CORS/CSP/origin + agent 403s on the P3 admin APIs available (`loader-origin.spec.ts`, `catalog/*`); the rest planned P4-P7 |
| Accessibility / perf | axe (in the e2e suite), Lighthouse, k6 | a11y (WCAG 2.x A/AA, light + dark), best-practices >= 95, ~1k sockets | axe available; Lighthouse/k6 planned P7/P8 |

## Running the checks

```bash
composer test          # artisan config:clear + pint --test + phpstan + artisan test
composer lint          # pint --parallel (fix)    | composer lint:check (verify only)
composer types:check   # phpstan analyse
npm run check          # vp check (lint/format)   | npm run check:fix
npm run types:check    # tsc --noEmit
composer ci:check      # npm run check + npm run types:check + composer test
```

The kit's GitHub Actions workflow (`.github/workflows/tests.yml`) runs `composer setup` then `composer ci:check`. The Playwright suite is **not** part of `ci:check` (it needs MySQL, a built frontend and Google Chrome): run it with `npm run e2e` (see below). A CI job for it needs a MySQL service, `npm run build`, Chrome (`channel: 'chrome'`, or `npx playwright install chrome`) and a `.env` (`cp .env.example .env`; the suite brings its own `APP_KEY`).

## End-to-end tests (Playwright)

```bash
npm run build && npm run build:widget   # the suite drives the built assets (public/build, public/widget/v1/loader.js); globalSetup rebuilds them itself when missing or older than the sources
npm run e2e                   # everything, desktop + mobile projects, headless Chrome (~4 minutes with the P3 specs)
npm run e2e:headed            # same, with a visible browser
npx playwright test e2e/auth/login.spec.ts --project=desktop      # one spec / one project
npx playwright show-report    # HTML report of the last run (traces + screenshots of failures)
npm run e2e:screenshots       # regenerate docs/screenshots/p1/*.png (see below)
```

Prerequisites: **the local pizzasys harness** (mode-2 scenarios, see below), local MySQL reachable with the credentials of `.env` (`DB_HOST/PORT/USERNAME/PASSWORD`), PHP 8.4 as `php` (override with `E2E_PHP=...`), Google Chrome installed (nothing is downloaded), `npm run build` done. The suite creates the databases it needs
(`CREATE DATABASE IF NOT EXISTS`, through the app's own connection settings) and **only ever touches databases named `chatfeature_e2e*`**; it never uses the dev database `chatfeature` or `chatfeature_testing`.

### The pizzasys harness (mode 2)

Mode-2 specs sign in through a **real pizzasys instance**: the throwaway harness that lives outside this repository (`../chatFeature.harness`, override with `E2E_HARNESS_DIR`). It serves a clone of pizzasys (SQLite, no NATS) on **127.0.0.1:8200** and is controlled with `run.sh start|stop|status|reset`. Its test accounts and service-client tokens are in `secrets.local.env` there; the suite reads that file at runtime and never copies anything from it into the repository, a spec, a report or a log. Needed once, or after the harness drifted: `../chatFeature.harness/run.sh reset` (clean baseline: users `admin@`, `chatadmin@`, `agent@`, `roleagent@`, `norole@`, `storeuser@test.local`, service clients `pne-chat` (the valid one), `other-svc`, `inactive-svc`, `expired-svc`).

`e2e/global-setup.ts` starts the harness whenever a mode-2 scenario is active (port 8200 must be free: it stops its own leftovers first and refuses to continue when something else answers), creates the suite's own portal accounts (`e2e.roles.<project>@test.local`, plain agents whose permissions the role-change spec edits) and stops the harness again in its teardown. Without the harness directory only `E2E_ONLY=...` runs of mode-1 scenarios work. **CI needs the harness** (a pizzasys clone, PHP 8.4 + SQLite) next to the checkout, or the mode-2 specs excluded: every mode-2 test carries the tag `@pizzasys`: `E2E_SKIP_PIZZASYS=1 npx playwright test --grep-invert @pizzasys` leaves out the mode-2 scenarios (no harness is started) and their tests (136 specs).

### How it works

The install wizard locks itself after the last step, so tests cannot share one server. Every **scenario** is a throwaway server of its own, declared once in `e2e/support/scenarios.ts`:

- started by Playwright's `webServer` (`php artisan serve --no-reload --host=127.0.0.1 --port=81xx`, `PHP_CLI_SERVER_WORKERS=4` so page and asset requests do not serialize) and stopped by it; nothing is left running;
- its own MySQL database, and a private storage directory `storage/e2e-<scenario>/` (`LARAVEL_STORAGE_PATH`: sessions, file cache, logs, compiled views) with the install state/lock files in `storage/e2e-<scenario>/state` (`INSTALL_STATE_DIR`). The directory is git-ignored; **`laravel.log` of a failing scenario is in there**;
- environment forced by the config (so `.env` cannot leak in): `SESSION_DRIVER=file`, `CACHE_STORE=file`, `QUEUE_CONNECTION=sync`, `BROADCAST_CONNECTION=null`, `MAIL_MAILER=log`, `BCRYPT_ROUNDS=4`, a fixed test `APP_KEY`, `APP_DEBUG=false` (`E2E_DEBUG=1` turns it on).

`e2e/global-setup.ts` resets every scenario before the suite (wipe the private storage dir, create the database, `chat:install:reset --force` env-scoped to that database) and prepares it by kind: `fresh` (nothing), `seeded` (wizard answers stored, so every wizard screen can be opened read-only with `?step=`), `installed` (`php artisan chat:install --mode=local` with `INSTALL_*` values, the extra test accounts of `e2e/support/users.ts`, and a saved admin + agent login per scenario so specs do not hit the login throttle). Playwright starts the servers *before* `globalSetup`; that is safe because readiness is checked on a static file (`/favicon.svg`), which does not boot Laravel.

| Scenario | Port | Database | Kind / environment | Used by |
|---|---|---|---|---|
| `fresh-local` | 8110 | `chatfeature_e2e` | fresh, `APP_ENV=local` (no token) | `install/wizard.spec.ts` (desktop project) |
| `fresh-local-mobile` | 8116 | `chatfeature_e2e_mobile` | same, own instance for the `mobile` project | `install/wizard.spec.ts` (mobile project) |
| `fresh-token` | 8111 | `chatfeature_e2e_token` | fresh, `APP_ENV=testing` + `APP_INSTALLED=false` + `SETUP_TOKEN=e2e-setup-token` | `install/gate.spec.ts`, `install/token.spec.ts`, a11y/responsive (token screen) |
| `fresh-token-mobile` | 8117 | `chatfeature_e2e_token_mobile` | same, for the `mobile` project | same specs, mobile project |
| `installed` | 8112 | `chatfeature_e2e_installed` | installed (mode 1), English | `auth/login.spec.ts`, `a11y`, `responsive`, screenshots |
| `wizard-views` | 8113 | `chatfeature_e2e_views` | seeded wizard answers, nothing installed, `APP_ENV=local` | `a11y`, `responsive` (every wizard screen, read-only) |
| `wizard-views-rtl` | 8114 | `chatfeature_e2e_views_rtl` | seeded, `APP_LOCALE=ar` | `rtl.spec.ts` |
| `installed-rtl` | 8115 | `chatfeature_e2e_installed_rtl` | installed with `INSTALL_LOCALE=ar` | `rtl.spec.ts` |
| `shots-desktop` / `shots-mobile` | 8118 / 8119 | `chatfeature_e2e_shots` / `_shots_mobile` | fresh, token mode; only started with `E2E_SCREENSHOTS=1` | `screenshots/p1.spec.ts` |
| `fresh-pizzasys` | 8120 / 8121 (mobile) | `chatfeature_e2e_pz_fresh` / `_pz_fresh_mobile` | fresh, `APP_ENV=local`; the spec picks the Auth Portal itself | `install/wizard-pizzasys.spec.ts` |
| `installed-pizzasys` | 8122 / 8123 (mobile) | `chatfeature_e2e_pz_installed` / `_pz_installed_mobile` | installed with `chat:install --mode=pizzasys` against the harness, a Testing environment (`other-svc`) configured, saved logins of `admin@` and `agent@` | `auth/login-pizzasys.spec.ts`, `auth/portal-outage.spec.ts`, a11y/responsive, `screenshots/p2.spec.ts` |
| `settings-pizzasys` | 8124 / 8125 (mobile) | `chatfeature_e2e_pz_settings` / `_pz_settings_mobile` | installed like the above but WITHOUT a Testing environment (the spec adds one and switches) | `settings/auth-settings.spec.ts` |
| `wizard-views-pizzasys` | 8126 | `chatfeature_e2e_pz_views` | seeded mode-2 answers (portal, roles, a verified portal admin), nothing installed | `a11y`, `responsive`, `screenshots/p2.spec.ts` |
| `wizard-views-pizzasys-rtl` | 8127 | `chatfeature_e2e_pz_views_rtl` | same, `APP_LOCALE=ar` | `rtl.spec.ts` |
| `installed-pizzasys-rtl` | 8128 | `chatfeature_e2e_pz_installed_rtl` | installed mode 2 with `INSTALL_LOCALE=ar`, Testing configured | `rtl.spec.ts` |

| `p3-categories` | 8230 / 8231 (mobile) | `chatfeature_e2e_p3_categories` / `_mobile` | installed (mode 1), seeded with `staff` (see below) | `catalog/categories.spec.ts` |
| `p3-agents` | 8232 / 8233 | `chatfeature_e2e_p3_agents` / `_mobile` | same | `catalog/agents.spec.ts` |
| `p3-widgets` | 8234 / 8235 | `chatfeature_e2e_p3_widgets` / `_mobile` | same, + host page server 8240 / 8241 | `widgets/widgets-list-and-builder.spec.ts`, `widgets/preview.spec.ts` |
| `p3-host` | 8236 / 8237 | `chatfeature_e2e_p3_host` / `_mobile` | same, + host page server 8242 / 8243 | `widgets/loader-host.spec.ts`, `widgets/loader-origin.spec.ts` |
| `p3-views` | 8238 | `chatfeature_e2e_p3_views` | installed, seeded with `demo` (the `staff` seed plus a published, fully configured widget "Acme Storefront"), host page server 8244; read-only, shared by both projects | `widgets/views.spec.ts` (axe, 375px), `screenshots/p3.spec.ts` |
| `p3-limits` | 8246 | `chatfeature_e2e_p3_limits` | installed, `staff` seed, host page server 8247; hammered by `widgets/loader-limits.spec.ts` (desktop project only) | `widgets/loader-limits.spec.ts` |
| `p3-views-rtl` | 8239 | `chatfeature_e2e_p3_views_rtl` | same, installed with `INSTALL_LOCALE=ar`, host page server 8245 | `widgets/views.spec.ts` (Arabic / RTL) |

Ports 8110-8129 and 8230-8249 and all `chatfeature_e2e*` databases belong to the suite. Stateful scenarios (`fresh-*`) get one instance per project (`instanceFor()` picks it from the project name), read-only ones are shared.

### P3 scenarios: seeds, the API fixture and the cross-origin host page

- **Seeds** (`seed` in `e2e/support/scenarios.ts`, run by `e2e/global-setup.ts` right after the install): `staff` adds three categories to the installer's "General" (Billing, Sales, Technical support), the agents Sara Ibrahim (serves Billing + Sales) and Tariq Aziz (Technical support), and Khalid Mansour, an administrator who does NOT take chats (`is_agent = false`; saved login `role: 'admin-only'`). `demo` also creates the published widget "Acme Storefront" through the management API (domains, greetings, categories, branding, texts, opening hours in `Asia/Kolkata`).
- **Specs create their own data**: the stateful P3 scenarios are shared by every test of a spec file (one server per project), so each test creates the widgets / categories / agents it needs through the API under a `unique()` name and never assumes the list is otherwise empty. Retries and the second project cannot collide.
- **`api` / `adminApi` fixtures** (`e2e/support/api.ts`, `test.ts`): the management API with Sanctum's cookie + `X-XSRF-TOKEN` exactly as the dashboard's own fetch wrapper sends them. `api` shares the cookies of `page`; `adminApi` is a context of its own with the saved administrator login, for specs whose `page` plays an anonymous visitor. `createWidget()` creates, configures (domains, categories, greetings, draft + publish, settings) and enables a widget in one call.
- **The customer site** (`e2e/support/host-server.mjs`, started by Playwright's `webServer` for every instance with a `hostPort`): a tiny static server on `http://localhost:<host port>` while the app is `http://127.0.0.1:<app port>`, so every embed is genuinely cross-origin (and `APP_URL` equals the origin the loader script comes from, which the loader insists on). `GET /page.html` is driven by the query string (`hostPage()` in `e2e/support/host.ts`): `key`, `src=w|generic|none` (`/w/<key>.js`, the generic `/widget/v1/loader.js` + `data-widget-key`, or no script), `attrs` (data-* attributes), `settings` (`window.ChatFeatureSettings`), `hostile` (`* { all: unset }`, `div, button { display: none !important }`, ...), `rtl`, `csp` (a strict page CSP: script/frame/connect sources of the app only, no inline styles), `twice`, `late`, `height`, `hostname` (`localhost`, `127.0.0.1`, `a.example.localhost`: other origins, same server). Every widget event lands in `window.__events`. Wildcard whitelist entries need a base of two labels, so the specs use `*.example.localhost:<port>`; Chrome resolves every `*.localhost` name to the loopback address.
- Loader timing: greetings are configured with a 1 s delay and a 3 s auto-hide; the `interval` dismiss policy runs on `page.clock` (a minute of waiting takes no time); the 10 s handshake watchdog is waited out for real once on desktop and once on a phone viewport (the P3 panel stub never sends `ready`). Geometry is measured after `settleWidget()` (entrance animations and transitions are over).

### Specs

| Spec | Proves |
|---|---|
| `install/gate.spec.ts` | Before install `/`, `/login`, `/dashboard` redirect to `/setup`; JSON/API callers get `503 {"error":"not_installed"}`; `/up` and built assets stay reachable. |
| `install/wizard.spec.ts` | One ordered test (steps): environment checks, mode step (Fortify preselected, the Auth Portal option selectable; selecting it routes to the portal step), server-side validation on admin/basics, defaults (`en`/`ar`, timezone, idle timeout 120), reload resumes the step, Back keeps answers, the four install steps go waiting -> running -> done, done -> `/login`, sign in as the new admin, admin dashboard, `/setup*` is 404 afterwards (JSON: `{"status":"installed"}`), `installed.lock` exists and no password/hash is left in the state file. Never retried (`retries = 0`): the server state cannot be rewound. |
| `install/token.spec.ts` | Environment check hidden before the token, wrong token refused, right token unlocks one browser session only, the token never appears in any HTML/JSON body or the state file, repeated wrong tokens get 429 (even the right one afterwards). Runs in order; the throttle test is last. |
| `auth/login.spec.ts` | Login form per mode-1 capabilities (reset link yes, registration/portal hint no), `/register` is 404, wrong password, admin sign in/out, unverified-email agent sees the agent dashboard and nothing of the admin view, a user with neither role is turned away with the "No chat access" notice, settings reachable (security asks to confirm the password), appearance toggle persists. |
| `a11y.spec.ts` | axe (WCAG 2.0/2.1/2.2 A+AA) on every wizard screen incl. validation and failed-install states, the token screen, login (also with errors / no-access notice), forgot password, both dashboards, profile and appearance settings, each in light and dark. `serious`/`critical` WCAG violations fail the test; everything else, including axe's best-practice rules, is attached to the report as `axe-*` JSON. Open best-practice findings (reported, not gating): positive `tabindex` values in the login form (kit code; removing them would put "Forgot your password?" between email and password in the tab order) and the app-shell sidebar content is not inside a landmark (`region`, kit `Sidebar`). The success screen is checked inside `wizard.spec.ts` (and `wizard-pizzasys.spec.ts`). **Mode 2:** the Auth Portal wizard steps (environment form, Testing open, passed and failed connection test with canned answers, validation errors, portal-admin verified card / sign-in form / refused account), the portal login (plain, error, no-chat-access; the unreachable notice inside `portal-outage.spec.ts`), Settings > Auth (plain, with a tested environment, the switch dialog) and the read-only profile, in light and dark. |
| `responsive.spec.ts` | At 375px: no horizontal scroll on every wizard screen, login and both dashboards, compact stepper instead of the rail, the sidebar becomes a drawer. **Mode 2:** every portal wizard step (compact stepper `Step n of 7`), a failed test with Testing open, long input and validation errors, a refused portal account, the portal login, Settings > Auth cards and the switch dialog. |
| `rtl.spec.ts` | `ar` locale: `<html dir="rtl" lang="ar">`, wizard rail and sidebar on the right, mirrored Back arrow, the mobile drawer from the right, no horizontal overflow (desktop + 375px). **Mode 2:** the portal wizard steps (technical fields stay left to right inside the mirrored form), the portal login, Settings > Auth and the switch dialog. Note: `lang/ar.json` is still a partial seed, missing keys fall back to English. |
| `install/wizard-pizzasys.spec.ts` | Mode 2, ONE ordered test against the harness, never retried: mode step -> Auth Portal -> portal environment (client validation, passing test with every check, a wrong service token failing the `service_credential` check with its fix hint, the right token again, a second post without typing it keeps the stored token) -> roles defaults -> Back shows "Token saved" -> portal admin (wrong password `invalid`, `norole@` `no_chat_access`, `agent@` `not_admin`, then `admin@` verified) -> basics -> install (4 steps) -> done (axe, both themes) -> sign in through the portal -> admin dashboard -> `/setup*` and every portal endpoint 404. Secrets: the service token is in no HTML/JSON response, not in any file under the instance storage (install state, sessions incl. the flashed old input of a server-rejected save, cache, logs, Inertia DevTools), and the stored column is encrypted. |
| `auth/login-pizzasys.spec.ts` | Mode 2 sign-in per portal account (`admin@` super-role and `chatadmin@` permission -> administrator, `agent@`/`roleagent@` -> agent without admin entries or `/settings/auth`, `norole@`/`storeuser@` -> "No chat access" notice), generic error for a wrong password and an unknown email, registration/reset/2FA/profile/password endpoints 404, read-only profile without Security page, logout, **revocation** (the portal's own logout with the session's upstream token ends the session within the verify TTL, lowered to its 15 s minimum) and **role changes** (grant `chat.admin` -> administrator, remove everything -> session ended, "No chat access" at the next sign-in, restore) picked up after the TTL. |
| `auth/portal-outage.spec.ts` | Stops the harness mid-session (own `pizzasys-outage` project, runs after all others): the signed-in administrator keeps working (grace), the health card says degraded/down, a new sign-in shows "Auth Portal unreachable" (axe, both themes), five failures open the circuit breaker, beyond the 30-minute grace (session aged in the database) the app answers a friendly 503 and keeps the session, after the restart the same session works again (the breaker closes by itself) and so do new sign-ins. |
| `settings/auth-settings.spec.ts` | Settings > Auth: agents get no nav entry and 403 on every endpoint; the health card; edit/save an environment (an omitted token keeps the stored one: renaming the service makes the portal refuse the stored token, renaming back works), connection test + persisted last check after a reload; add a Testing environment (`other-svc`); role mapping (validation, a mapping nobody matches ends the agent's session on their next request, restore, super role chips); the environment switch (acknowledgement + admin credentials on the target required, an agent account and a wrong password are refused with `settings-auth-switch-problem` and nobody is signed out, an admin switches: everybody is signed out, sign-in works on Testing, switch back); mode 1 shows `settings-auth-managed` and 404s every write, agents get 403 in both modes. |
| `catalog/categories.spec.ts` | `/categories` (admin only): the seeded list with agent/widget counts, create (name, slug that follows the name, description, colour, icon, translated names), edit (the same, slug kept, the same language twice refused), search, reorder with up/down (distinct sort orders, persisted), deactivate/reactivate, delete with its confirm (and the "in use" dialog with "Deactivate instead", simulated: chats arrive in P4), a taken slug (field error 422; the lost-race `409 slug_taken` shown in the dialog), the API envelopes (`{data}`, `{error:{code,details}}`, no integer ids), agents: no admin navigation, 403 page, 403 on every write. |
| `catalog/agents.spec.ts` | Mode 1 staff list (roles, categories, local-account badge, search, category and role filters), the create dialog (client and server validation, a taken email, categories, the new agent really signs in), API shape (nothing secret), optimistic category assignment (the chip shows before the response, rolled back with the server's message when refused, `+N more`), an admin who does not take chats cannot serve categories (`409 not_an_agent`), the "Takes chats" switch only on admin rows (switching off drops the categories), deactivate/reactivate (a deactivated account cannot sign in), no self-deactivation, concurrent-chats limit (Enter/blur, snaps back, server range), the agent's "My support categories" (persists, visible on the admin page, inactive categories hidden), the administrator without `is_agent` sees the explanation, agents get 403 on the admin pages and APIs. `@pizzasys`: the Agents page in mode 2 (portal notice, no create button, disabled active switches, no role switches, `409 managed_by_auth_portal`, limits still editable). |
| `widgets/widgets-list-and-builder.spec.ts` | Widget list (create -> opens in the builder as published v1 / disabled, card badges, key copy, enable from the card, delete with confirm and its public endpoints turning 404), API envelopes without the identity secret. Builder: every tab changes values, saves and keeps them after a reload (General incl. `Asia/Kolkata`, Branding, Texts incl. an added language, Features + pre-chat, Greetings, Hours, Domains, Categories); hours: an overlapping range is flagged on its row (client) and a server error lands on the right row, holidays without a name, duplicate dates; domains: client rules, server refusal of `*.co.uk` on its chip, `http://` kept / `https://` dropped, applied immediately; draft vs published (public config and `/w/<key>.js` keep the old design until Publish, then the new one with a bumped version and a new ETag; greetings/domains/categories are live at once); server field errors mapped to the right tab and field; going live/offline through the confirm dialog (404 for visitors while offline); snippets and clipboard; the identity secret is shown once and never again (also not by any endpoint); a legacy zone name (`Asia/Calcutta`) round-trips. |
| `widgets/preview.spec.ts` | The builder's live preview runs the REAL loader in an `<iframe srcdoc>` (open shadow root, themed from the unsaved draft), the three device frames, LTR/RTL and light/dark rebuild the host page, primary colour / launcher label / corner update live without a reload, an edited greeting is what the preview greets with, an emptied text override is gone after the host reboots, "Open chat" loads `/embed/<key>?preview=1`, and the static approximation (by hand, when the bundle is a stub, when the request fails). |
| `widgets/loader-host.spec.ts` | The widget on a cross-origin host page: bundle <= 16 KB gz; bubble in an open shadow root styled from the dashboard (size, corner, offsets, icon); hostile host CSS and a strict page CSP; `data-*` / `ChatFeatureSettings` precedence, junk values ignored, a host cannot switch greetings on nor add categories; greeting delay, agent, flip, auto-hide, weighted pick with a fixed `Math.random`, never the same twice, the `session` / `never` / `interval` dismiss policies, Escape, click-to-open, reduced motion, phone layout; the panel iframe (`/embed/<key>`, sandbox), the 10 s handshake watchdog on desktop and the full-screen trap on a phone (launcher stays on top, host scroll locked then unlocked), Escape and the launcher closing it at once; the JS API (`open/close/toggle/show/hide/update/getState/on/off`, DOM events, replay of queued calls, unknown commands, double include, `shutdown` cleaning everything). |
| `widgets/loader-origin.spec.ts` | Who may use a widget: the generic loader on an unlisted origin (CORS-blocked, 403 `origin_not_allowed`, no ACAO, no bubble), the CSP `frame-ancestors` of `/embed/<key>` (the whitelist, `'none'` for `/c/<key>`, `?preview=1` refused to anonymous callers, an unlisted site's iframe is blocked), wildcard whitelists (`*.example.localhost`: sub-origins yes, apex and lookalikes no), preflights, missing/`null` origin, `allow_non_browser_clients`, domain changes taking effect at once; the config endpoint's shape/headers/ETag/304 (with CORS on the 304), `/w/<key>.js` following every change, no `Set-Cookie` anywhere and no cookie after a visit, disabled/deleted widgets (404, no bubble), the generic loader's own credential-less CORS config fetch, a late script tag, a hostile pre-registered boot config, messages from the host page itself ignored, RTL host pages keep the launcher corner. |
| `widgets/loader-limits.spec.ts` | Rate limits of the public endpoints (own `p3-limits` server, desktop project only): a flood from a listed origin ends in a `429` that stays readable for that origin (CORS headers, `Access-Control-Expose-Headers: Retry-After`, JSON error, no cookie) after about 300 requests while an unlisted origin's 403s do not spend the widget's budget; probing unknown keys is limited (no CORS header). |
| `widgets/concurrency.spec.ts` | Sixteen clients create and fully configure widgets in parallel (80 widgets: domains, categories, greetings, draft, publish, enable): no `500`. Regression test for the MySQL deadlocks (error 1213) of the replace-the-set actions. |
| `widgets/escaping.spec.ts` | HTML in category / agent / widget names, descriptions, greetings, launcher label and texts is shown as text in the dashboard lists, dialogs, every builder tab, the live preview and the widget on a host page (nothing runs, no element is created). |
| `widgets/views.spec.ts` | axe (WCAG A/AA, light + dark) on categories (list, dialogs), agents, widgets, every builder tab, the publish/go-live dialogs, the validation state, both preview views, support categories (agent and administrator) and the widget itself (launcher, popup, opened frame) on the host page; document structure (heading order, one main landmark); 375px (no sideways scrolling, dialogs and popovers inside the screen, builder edit/preview switch, the full-screen panel); Arabic/RTL (sidebar on the right, builder tabs, preview, drawer from the right, axe). |
| `screenshots/p1.spec.ts` / `p2.spec.ts` / `p3.spec.ts` | Only with `E2E_SCREENSHOTS=1`: see below. |

Helpers: `e2e/support/api.ts` (management API fixture, `createWidget`), `host.ts` + `loader.ts` + `host-server.mjs` (the cross-origin customer site, widget locators, event log, `liveWidget`), `e2e/support/harness.ts` (harness control, secrets, portal-side edits), `portal.ts` (UI sign-in, verify TTL, cache flush, the session's upstream token), `leaks.ts` (secret search), `shots.ts` (screenshot helpers), `e2e/support/test.ts` (the `test` to import: `test.use({ scenario: 'installed', role: 'admin' })` sets the base URL and starts from the saved login), `helpers.ts` (`setTheme`, `settle`, `expectNoHorizontalScroll`, `expectNoSeriousA11yViolations`), `wizard.ts` (wizard driver), `users.ts` (test accounts), `artisan.ts` (`php artisan` against one instance, refuses anything but `chatfeature_e2e*`).

### Rules of the suite

- **Web-first assertions only**; no `waitForTimeout`. Colour measurements (axe, screenshots) call `settle()` first: CSS transitions/fade-ins are 150-300ms and give false contrast failures if measured mid-way.
- Fortify throttles the login form (5 attempts a minute per email) and the setup-token form (5 a minute per IP): specs that type credentials use their own accounts per project (`loginAccounts()`), everything else starts from a saved session.
- Test accounts, the setup token and the `APP_KEY` are throwaway values that only exist in the `chatfeature_e2e*` databases/servers.
- `E2E_ONLY=installed,fresh-token npx playwright test ...` starts only those scenarios (handy while writing a spec; mode-2 specs need their `*-pizzasys*` scenarios in the list, which also starts the harness). Unknown extra env: `E2E_DEBUG=1` (APP_DEBUG), `E2E_PHP` (php binary), `E2E_HARNESS_DIR` (the pizzasys harness).
- **Mode-2 specs share the one harness**: nothing but `portal-outage.spec.ts` may stop it, and that spec runs alone in the last project (`pizzasys-outage`, which depends on `desktop` and `mobile`; run it by itself with `npx playwright test --project=pizzasys-outage --no-deps`). Specs only ever change the suite's own `e2e.roles.*` accounts upstream and restore them. Revocation and role-change specs lower `auth.pizzasys.verify_ttl_seconds` to its minimum (15 s) and poll, so each takes about 20-30 s.
- `browser.newContext()` inherits the saved session of `test.use({ role })`: pass `storageState: { cookies: [], origins: [] }` for a signed-out second browser.
- Type-check the suite with `npx tsc -p e2e/tsconfig.json`.

### Add a scenario or a spec

1. Scenario: add an entry to `DEFINITIONS` in `e2e/support/scenarios.ts` (`kind`, a free port in 8110-8119, a `dbSuffix` -> `chatfeature_e2e<suffix>`, `mode: 'local' | 'token'`, optional `locale`, `perProject` for stateful ones) and the name to `ScenarioName`. Nothing else: the `webServer` list, the reset, the install and the saved logins are derived from it.
2. Spec: `e2e/<area>/<name>.spec.ts`, `import { expect, test } from '../support/test'`, `test.use({ scenario: '<name>' })` (+ `role: 'admin' | 'agent'` for installed scenarios). Stateful flows: one ordered test or `test.describe.configure({ mode: 'serial', retries: 0 })`.
3. Prefer `data-testid` selectors (the contract with the frontend; the login/confirm/logout buttons use the kit's `data-test`).

### Run only the mode-2 specs

```bash
E2E_ONLY=fresh-pizzasys,installed-pizzasys,settings-pizzasys,wizard-views-pizzasys,wizard-views-pizzasys-rtl,installed-pizzasys-rtl,installed \
  npx playwright test e2e/install/wizard-pizzasys.spec.ts e2e/auth/login-pizzasys.spec.ts e2e/auth/portal-outage.spec.ts e2e/settings
```

### Run only the P3 specs

```bash
E2E_ONLY=p3-categories,p3-agents,p3-widgets,p3-host,p3-views,p3-views-rtl E2E_SKIP_PIZZASYS=1 \
  npx playwright test e2e/catalog e2e/widgets
```

### Screenshots for the deck

`npm run e2e:screenshots` walks the real first-run flow (token, wizard, install) on `shots-desktop` and `shots-mobile`, then captures sign-in (plain, wrong password, no chat access), admin and agent dashboards, settings and the Arabic/RTL screens. Output: `docs/screenshots/p1/NN-description-{desktop|mobile}-{light|dark}.png` (full page; desktop 1280px @1x, mobile 375px @2x; reduced motion, fonts and transitions settled, caret hidden). The old PNGs in that folder are replaced on every run. The files are committed so the PowerPoint deck can use them without running anything.

`E2E_SCREENSHOTS=1` also runs `screenshots/p2.spec.ts` (needs the harness): the mode-2 wizard (sign-in method, portal environment, Testing open, passed and failed connection test with its fix hint, validation, verified and refused portal admin, install summary, done), the portal sign-in (plain, wrong password, no chat access, portal unreachable) and Settings > Auth (health, a tested environment, roles, the switch dialog, the health card while the portal is down, the read-only profile) into `docs/screenshots/p2/NN-description-{desktop|mobile}-{light|dark}.png` (22 screens, 88 PNGs). The PNGs are git-ignored. The wizard screens come from the read-only `wizard-views-pizzasys` scenario (connection tests and install steps are answered locally, nothing is saved); the unreachable screens stop the harness for a few seconds and start it again.

`E2E_SCREENSHOTS=1` also runs `screenshots/p3.spec.ts` (no harness needed: `E2E_ONLY=p3-views E2E_SKIP_PIZZASYS=1 npx playwright test e2e/screenshots/p3.spec.ts --project=desktop`): categories (+ dialog), agents (+ category picker, create dialog), the widget list, every builder tab with its live preview, a validation state, the preview in 1024/768/375px device frames and as the static approximation, the agents' support categories (and the not-an-agent notice), and the real widget on a customer-site page of another origin (closed bubble, the flip with its greeting popup, the opened chat frame) into `docs/screenshots/p3/NN-description-{desktop|mobile}-{light|dark}.png` (25 screens, 100 PNGs, git-ignored). The widget shots follow the page's colour scheme; the widget list runs on a fixed page clock so "Updated 5 minutes ago" never changes.

## Gate checklist (end of every phase)

1. `composer test` (pint + larastan + phpunit), `tsc`, lint, Vitest, `npm run e2e` all green.
2. `/code-review` at high effort; fix findings.
3. `/security-review`; fix findings.
4. `/simplify`.
5. Update `CLAUDE.md` (via `claude-md-management:revise-claude-md`), the README roadmap checkboxes, the relevant `docs/*.md` and `docs/changelog.md`.
6. Commit `phase-N: <summary>` and tag `v0.N.0`. No push unless asked.

## Notable exit tests per phase

| Phase | Must be proven |
|---|---|
| P1 | Gate/503/lock idempotency, setup token, concurrent install run, driver switch, RTL snapshot |
| P2 | ok/invalid/unavailable/no-role/cache/revoked/degraded/service-token-rejected/env flip; NATS replay + deactivation; real-pizzasys run documented (e2e against the harness: `wizard-pizzasys`, `login-pizzasys`, `portal-outage`, `auth-settings`) |
| P3 | Cross-origin host page; origin/CORS/CSP/JWT (valid/expired/forged); builder preview equals real widget (e2e: `widgets/loader-host.spec.ts`, `loader-origin.spec.ts`, `preview.spec.ts`; the JWT part waits for the identity consumers of P4) |
| P4 | Concurrent-accept race (MySQL); idle auto-close; queue timeout to offline ticket; reconnect sync; attachment abuse; IDOR matrices |
| P5 | Presence across hidden/closed tab; OS notification only when unfocused; push delivery by logs + manual checklist |
| P6 | Signature valid/tampered/missing/replay; linking; agent isolation 403; real-device round trip |
| P7 | Analytics reconcile with raw data; headers grade A; no cross-widget/visitor access; load results |
| P8 | Clean-machine compose run over HTTPS; restore drill; Lighthouse/axe recorded |
