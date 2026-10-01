# Testing

> Status: partially live. PHP checks, `vp`/`tsc`, Vitest and the Playwright e2e suite (install wizard, sign-in, shell, a11y, responsive, RTL, and auth mode 2 against a real local pizzasys) are live; size-limit and k6 are planned.

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
| Bundle budget | size-limit | Loader <= 15 KB gz | planned P3 |
| E2E | Playwright on real Google Chrome (desktop 1280x800 + Pixel 7 profiles) | Install wizard, setup token, sign-in, role-aware shell, axe, 375px, RTL; mode 2: portal wizard, portal sign-in, revocation, role changes, outage, Settings > Auth; later: two-browser chat lifecycle, cross-origin embed | P1 + P2 available (`npm run e2e`), P4/P8 planned |
| Integration | Docker `nats -js`, real pizzasys clone, real OpenWA image | NATS idempotency/deactivation, token TTL, QR to ready, recorded fixtures | pizzasys clone: used by the mode-2 e2e (no NATS); NATS + OpenWA planned P6 |
| Security matrices | PHPUnit/Playwright | Channel-auth, visitor IDOR, agent isolation (403), CORS/CSP/origin, upload abuse (spoof/oversize/EXIF/SVG) | planned P3-P7 |
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
npm run build                 # the suite drives the built assets in public/build (rerun after frontend changes)
npm run e2e                   # everything, desktop + mobile projects, headless Chrome (~1 minute)
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

Ports 8110-8129 and all `chatfeature_e2e*` databases belong to the suite. Stateful scenarios (`fresh-*`) get one instance per project (`instanceFor()` picks it from the project name), read-only ones are shared.

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
| `screenshots/p1.spec.ts` / `p2.spec.ts` | Only with `E2E_SCREENSHOTS=1`: see below. |

Helpers: `e2e/support/harness.ts` (harness control, secrets, portal-side edits), `portal.ts` (UI sign-in, verify TTL, cache flush, the session's upstream token), `leaks.ts` (secret search), `shots.ts` (screenshot helpers), `e2e/support/test.ts` (the `test` to import: `test.use({ scenario: 'installed', role: 'admin' })` sets the base URL and starts from the saved login), `helpers.ts` (`setTheme`, `settle`, `expectNoHorizontalScroll`, `expectNoSeriousA11yViolations`), `wizard.ts` (wizard driver), `users.ts` (test accounts), `artisan.ts` (`php artisan` against one instance, refuses anything but `chatfeature_e2e*`).

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

### Screenshots for the deck

`npm run e2e:screenshots` walks the real first-run flow (token, wizard, install) on `shots-desktop` and `shots-mobile`, then captures sign-in (plain, wrong password, no chat access), admin and agent dashboards, settings and the Arabic/RTL screens. Output: `docs/screenshots/p1/NN-description-{desktop|mobile}-{light|dark}.png` (full page; desktop 1280px @1x, mobile 375px @2x; reduced motion, fonts and transitions settled, caret hidden). The old PNGs in that folder are replaced on every run. The files are committed so the PowerPoint deck can use them without running anything.

`E2E_SCREENSHOTS=1` also runs `screenshots/p2.spec.ts` (needs the harness): the mode-2 wizard (sign-in method, portal environment, Testing open, passed and failed connection test with its fix hint, validation, verified and refused portal admin, install summary, done), the portal sign-in (plain, wrong password, no chat access, portal unreachable) and Settings > Auth (health, a tested environment, roles, the switch dialog, the health card while the portal is down, the read-only profile) into `docs/screenshots/p2/NN-description-{desktop|mobile}-{light|dark}.png` (22 screens, 88 PNGs). The PNGs are git-ignored. The wizard screens come from the read-only `wizard-views-pizzasys` scenario (connection tests and install steps are answered locally, nothing is saved); the unreachable screens stop the harness for a few seconds and start it again.

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
| P3 | Cross-origin host page; origin/CORS/CSP/JWT (valid/expired/forged); builder preview equals real widget |
| P4 | Concurrent-accept race (MySQL); idle auto-close; queue timeout to offline ticket; reconnect sync; attachment abuse; IDOR matrices |
| P5 | Presence across hidden/closed tab; OS notification only when unfocused; push delivery by logs + manual checklist |
| P6 | Signature valid/tampered/missing/replay; linking; agent isolation 403; real-device round trip |
| P7 | Analytics reconcile with raw data; headers grade A; no cross-widget/visitor access; load results |
| P8 | Clean-machine compose run over HTTPS; restore drill; Lighthouse/axe recorded |
