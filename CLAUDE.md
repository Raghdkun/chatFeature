# PNE Chat — project memory for Claude

@AGENTS.md

> Living document. Updated at the end of every phase (see "Phase gate"). The approved build plan is
> `/Users/raghd/.claude/plans/first-we-will-install-concurrent-lighthouse.md`; the public roadmap is `README.md`.

## What this is

A self-hosted, tawk.to-style live-chat platform: embeddable bubble -> visitor picks a topic -> an agent
accepts -> live chat (+ optional WhatsApp via the self-hosted OpenWA gateway). Admins see everything,
agents only their assigned chats. Single organisation, many widgets (schema is workspace-ready).

**Locked decisions** (do not re-litigate; change only via the user):
- Broadcast new chat requests to **all online agents owning the category; first Accept wins** (atomic SQL claim).
- WhatsApp = **hand-off + record**; history **admin-only**; agents never see WhatsApp chats.
- One-time **setup wizard**: mode 1 = starter-kit Fortify auth, mode 2 = external **pizzasys** auth
  (prod + testing domain, switchable). In mode 2 Admin/Agent come **only** from pizzasys roles/permissions.
- Visitors: anonymous + per-widget pre-chat form; they never see history; new visit = new ticket.
- English now, **i18n + RTL ready** (logical CSS, `lang/*.json`). Deploy: Docker Compose + Caddy on Hostinger KVM.

## Stack (resolved versions, 2026-09-30)

Laravel 13.34 · PHP 8.4 (min ^8.3) · Inertia 3 + React 19 + TypeScript · Tailwind 4 · shadcn/ui (new-york, neutral) ·
Fortify (2FA, passkeys) · Wayfinder · Vite 8 via **vite-plus (`vp`)** · Reverb 1.12 · Sanctum 4.3 ·
laravel-notification-channels/webpush 13 · intervention/image 4.3 · basis-company/nats 1.2 ·
spatie/laravel-data 4.23 + typescript-transformer 3.3 · Scribe 5.11 (dev) · Laravel Boost 2.10 (dev) ·
PHPUnit 12 (not Pest) · Larastan · Pint · Vitest (via `vp test`) · Playwright · MySQL 9.6 local · Redis 8 local.

## Commands

```bash
composer setup            # first-time: install, key, migrate, npm install, build   (NOTE: wizard owns migrate in real use)
composer dev              # php artisan dev  (multiplexed dev runner)  + run `php artisan reverb:start` and a queue worker
composer test             # config:clear + pint --test + phpstan + phpunit  (the PHP gate)
composer lint             # pint (fix)             composer types:generate  # PHP Data classes -> resources/js/types/generated.d.ts
npm run check             # vp check = format + lint     npm run check:fix
npm run types:check       # tsc --noEmit                 npm test   # Vitest (vp test run)
npm run build             # vp build (the app + embed entry; does NOT build the loader)
npm run build:widget      # the embeddable loader -> public/widget/v1/loader.js (git-ignored; Docker must run it)
npm run size              # size-limit: loader <= 16 KB gzip (the P3 build is 15.65 KB)
npm run e2e               # Playwright e2e (real Chrome, MySQL chatfeature_e2e*; see docs/testing.md); also e2e:headed, e2e:screenshots
composer ci:check         # everything above, as CI runs it (not Playwright, not size-limit)

php artisan chat:install --mode=local|pizzasys   # non-interactive install from INSTALL_* env; chat:bootstrap-secrets; chat:install:reset (APP_ENV=local only)
php artisan chat:auth:test|switch-env|set-env|reactivate   # mode-2 ops and break-glass (see docs/runbook.md)
php artisan chat:auth:consume-nats --instance=main         # supervised NATS consumer; chat:auth:prune-sessions (scheduled daily), chat:auth:prune-events
```

Dev DB is the **dedicated** local MySQL database `chatfeature` (tests: `chatfeature_testing`, though PHPUnit
defaults to in-memory SQLite). Never touch the user's other local databases. Dev helpers (mailpit, NATS,
OpenWA, optional mysql/redis) are in `docker/compose.dev.yml` behind profiles; **Docker Desktop must be running**.

## Layout & extension points (see `docs/contracts/ownership.md`)

- `app/Domain/<Context>/Actions` single-purpose classes; thin controllers; models flat in `app/Models`;
  one `app/Providers/<Context>ServiceProvider` per context (all registered in `bootstrap/providers.php`).
- Routes never edited in shared files: drop `routes/web/<ctx>.php`, `routes/api/management/<ctx>.php`,
  `routes/api/public/<ctx>.php`, `routes/webhooks/<ctx>.php` (loaded by `App\Support\RouteFiles`).
  Public + webhook routes use the bearer-only `widget` middleware group (never stateful/CSRF).
- Sidebar: `resources/js/nav/<NN>-<ctx>.ts` default-exports `NavEntry[]`; `navFor(user)` filters by role.
- Shared payloads: `app/Data/**` with `#[TypeScript]` -> `composer types:generate`. PHP is the source of truth.
- Widget loader: vanilla TS in `resources/widget/src` (tests `resources/widget/test`, dev host page `resources/widget/dev`); built by `vite.widget.config.ts`. The chat panel `resources/js/embed/main.tsx` is a **stub until P4**.
- Every `api/*` error is `{error:{code,message,details?}}` (`App\Exceptions\ApiErrorRenderer`); expected failures throw `App\Http\Exceptions\ApiProblemException` with their own code (`docs/contracts/rest-shapes.md`).
- Public IDs are ULIDs / `public_key`; never leak integer PKs to visitors or APIs.
- `docs/contracts/*` are orchestrator-owned; parallel tracks request changes, they don't edit them.

## Gotchas learned (read before debugging)

1. **System git is blocked** on this Mac (`/usr/bin/git` -> "Xcode license not agreed"). Use `/opt/homebrew/bin/git`
   explicitly, or a PATH dir that exposes only that git. Do **not** put `/opt/homebrew/bin` first on PATH: it
   switches PHP to Homebrew 8.5 instead of the Herd-lite 8.4 this project targets.
2. `laravel new .` refuses even an empty dir; scaffold from the parent (`laravel new chatFeature ...`). The
   installer's 300 s composer timeout kills the npm step — finish `key:generate`/`npm install` manually.
3. **Guzzle is pinned to ^7.9** in `composer.json` on purpose: Laravel 13.34 resolves Guzzle 8 / psr7 3 by default,
   but Reverb 1.12 and `pusher-php-server` need Guzzle 7 / psr7 2. Keep the pin (and `-W` when adding packages).
4. `php artisan install:api` **runs migrations** against the configured DB. Wipe with `php artisan db:wipe --force`
   before testing the wizard (the wizard must start from a truly empty DB).
5. `BROADCAST_CONNECTION=reverb` without `REVERB_APP_KEY` crashes *every* artisan command (channels.php loads the
   broadcaster). P1's `InstallAwareConfigProvider` forces `null` until installed; until then run one-off commands with
   `BROADCAST_CONNECTION=null`. `install:broadcasting` needs a TTY for its npm step — run `npm i` manually.
6. `.npmrc` has `ignore-scripts=true`. e2e uses the installed Google Chrome (`channel: 'chrome'`); no browser download. Never drive e2e/screenshots through the Playwright/chrome-devtools **MCP** browsers from a sub-agent (one hung for an hour): use `npx playwright test`. macOS has no `timeout` binary.
7. The kit's `dialog.tsx` has no `showCloseButton` prop; the added shadcn `command.tsx` was patched to match. All other
   kit UI files are untouched — the shadcn CLI prompts before overwriting, answer **n**.
8. `vp check` formats Markdown too: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/**` and generated TS files are
   excluded in `vite.config.ts` (`fmt.ignorePatterns`). The nav glob excludes `index.ts` and `*.test.ts`.
9. `AGENTS.md` is generated by Laravel Boost (`php artisan boost:update` regenerates it) — put project rules **here**,
   not there. Boost's MCP (`.mcp.json`, gitignored) loads next session; context7 + docs cover the same need meanwhile.
10. MySQL `NULL` in a UNIQUE index is not unique: tenant tables use a virtual `workspace_key = COALESCE(workspace_id,0)`.
11. Verified OpenWA webhook signature: header `X-OpenWA-Signature: sha256=<hex>`, HMAC-SHA256 over the **raw body**; OpenWA rejects
    webhook URLs resolving to private addresses unless `SSRF_ALLOWED_HOSTS` allows the app host. pizzasys `refresh-token`
    revokes **all** of a user's tokens — never call it by default. Verified locally (`docs/pizzasys-findings.md`): pizzasys login tokens
    **never expire**, re-login doesn't revoke older tokens, bad user tokens verify as HTTP 200 `active:false`, bad *service* credentials are
    HTTP 401 (never 403), `super-admin` carries no `chat.*` permission (check the role name), and NATS `user.updated` leaks a password hash.
12. Behind Caddy set `TRUSTED_PROXIES` (address list or `*`) or the client IP/scheme are wrong (throttles, audit log, URLs). Settings are memoised per
    process for only 2 s (`SettingsRepository::MEMO_TTL_SECONDS`) so queue workers don't serve stale values. Test helper `Tests\Support\InstallStateFake::make()`
    replaces the old `InstallState::fake()`.
13. **Tests never reach a network.** `tests/TestCase.php` calls `Http::preventStrayRequests()` and binds a fake DNS `HostResolver` (every name resolves to one public address) and a fake `NatsProbe`:
    every HTTP call in a test needs a `Http::fake`. `WidgetFixtures::useFortifyMode()` stores `auth.mode=fortify` (an installed instance without it makes `AuthModeGuard` fail closed with `500 auth_mode_unavailable`,
    so staff/agent tests call it); `usePizzasysMode()` is the mode-2 stub. Skipped on purpose: `PIZZASYS_HARNESS=1` (real pizzasys clone) and `NATS_TEST_URL=nats://127.0.0.1:4222` (a real `nats -js`).
14. **pizzasys facts + harness:** `docs/pizzasys-findings.md`. The local clone lives OUTSIDE the repo at `../chatFeature.harness/` (`run.sh start|stop|status|reset`, port 8200, `secrets.local.env` is never copied into the repo).
    Mode-2 e2e tests carry the tag `@pizzasys`: `E2E_SKIP_PIZZASYS=1 npx playwright test --grep-invert @pizzasys` skips them and the harness. A real NATS server has never been run against the consumer.
15. **Loader:** the bundle `public/widget/v1/loader.js` is git-ignored, so a fresh checkout/Docker image must run `npm run build:widget`; without it `/w/{key}.js` serves a stub and the builder falls back to its static preview.
    Budget 16 KB gzip (`npm run size`; 15.65 KB now). `resources/js/lib/limits.ts` repeats the PHP validation limits and `limits.test.ts` pins it to the PHP source; `resources/js/lib/widgets-routes.ts` holds plain URL strings
    (Wayfinder output is git-ignored) pinned to the contract by a Vitest test and exercised against the real routes by the P3 e2e.
16. **Env vars worth knowing:** `TRUSTED_PROXIES`, `SETUP_TOKEN` (skipped only for `APP_ENV=local` + loopback peer + no proxy header), `SANCTUM_EXPIRATION_MINUTES` (30 days), `PORTAL_ALLOW_PRIVATE_HOSTS` (portal/NATS on a private network),
    `NATS_TLS_CA_FILE` (the other `NATS_*` only feed the config-backed provider used in dev/tests: in production the active auth environment's NATS address in Settings > Auth switches the consumer on), `INSTALL_*` (install time only).
17. **Frontend traps:** `Toaster` (`components/ui/sonner.tsx`) already registers `useFlashToast`: never mount it again. Widget `timezone` is validated `timezone:all_with_bc` everywhere (settings PATCH, wizard, `WidgetConfigValidator`), so legacy names like `Asia/Calcutta` round-trip; the builder shows the canonical name (`lib/timezones.ts`).
18. **Security headers:** `SecurityHeaders` (web group) sets `frame-ancestors 'self'`/`X-Frame-Options` on dashboard pages unless a response sets its own framing; `/embed/{key}`, `/c/{key}` and `/w/{key}.js` run WITHOUT the web group (no session, no cookies)
    and send their own headers. `/w/{key}.js` also answers 403 to a `Referer` that is not on the widget's domain list (no `Referer` = served). See `docs/security.md`.
19. **Parallel work (git worktrees):** every track/agent works in its own worktree and branch and edits only the files it owns; the merge rules are in `docs/contracts/ownership.md` "Parallel-merge rules". Highlights: tracks never commit the generated
    `resources/js/types/generated.d.ts` / `typescript-transformer-manifest.json` (type-check with `composer types:generate`, then `git checkout --` both files; the orchestrator regenerates once after merging); new `lang/en.json` keys only under your own prefix;
    shared files and `docs/contracts/*` change only through the orchestrator. The e2e suite owns ports 8110-8129 and the `chatfeature_e2e*` databases: start nothing else there. The external Rag volume can disconnect mid-session
    (it then looks like a deleted cwd): check `/Volumes` first and stop instead of guessing.
20. **MySQL deadlocks:** actions that delete and re-insert rows of one parent (widget domains/greetings/categories, an agent's categories) run in `App\Support\Database\DeadlockRetry::transaction()` (6 attempts, random growing pause). Use it for any new replace-the-children action; Laravel's `DB::transaction($cb, $attempts)` retries instantly and re-collides under load.
21. **Auth Portal page copy:** the sign-in page and profile name/link the portal only for a public DNS name (`PortalLabel`); a loopback/private portal (the e2e harness) shows no host and no link. Saving a changed portal address, service name or TLS setting needs the token re-entered, and on the live environment passes a connection test first.

## Security rules

- Never commit real credentials/tokens (pizzasys service token, OpenWA API key, VAPID/Reverb secrets). `.env` is ignored;
  secrets live encrypted in the DB (`settings.is_encrypted`, `auth_environments.*_encrypted`).
- Visitor tokens are hashed at rest and bound to one conversation. Every new endpoint needs a policy/IDOR test.
- WhatsApp data (`wa_*`) is admin-only everywhere: routes, Inertia pages, channels, search. Agents get 403/hidden.

## Phase gate (end of every phase)

1. `composer ci:check` green (pint, phpstan, phpunit, `vp check`, `tsc`, Vitest) + Playwright smoke when e2e exists.
2. `/code-review` (high) -> fix; `/security-review` on the phase diff; `/simplify`.
3. Update this file, `README.md` roadmap checkboxes, relevant `docs/*.md`, `docs/changelog.md`.
4. Commit `phase-N: <summary>` + tag `v0.N.0`. **No push** unless the user asks. Commit trailer:
   `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Status

| Phase | State |
|---|---|
| P0 Scaffold + tooling | done (see `docs/changelog.md`) |
| P1 Install gate, wizard, settings, mode-1 auth, shell | done (`v0.1.0`) |
| P2 Mode-2 pizzasys auth | done (`v0.2.0`), reviewed + hardened, e2e against the local pizzasys clone. Real NATS server never exercised; pizzasys facts from a local clone only |
| P3 Widgets/loader/builder/categories/agents | done (`v0.3.0`), reviewed + hardened, e2e on a cross-origin host page. Panel is a stub until P4; `availability.online` false until P5; loader 15.65 of 16 KB |
| Gate at `v0.3.0` (`integrate/phase-2-3`) | `composer ci:check` green: PHPUnit 1667 (7 skip: harness / NATS server), Vitest 1193 (incl. the loader tests), PHPStan L7, Pint, `vp check`, `tsc`. Playwright 483 specs, 480 pass, 3 skipped, 0 failed (needs the harness on :8200, started by `global-setup`) |
| P4 Chat core · P5 Presence/notifications · P6 WhatsApp · P7 Analytics/hardening · P8 Deploy/QA/deck | planned |
