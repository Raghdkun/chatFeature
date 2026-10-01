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
npm run build             # vp build                     npm run e2e  # Playwright (needs `npx playwright install`)
composer ci:check         # everything above, as CI runs it
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
6. `.npmrc` has `ignore-scripts=true`. Playwright browsers are **not** downloaded: run `npx playwright install` when e2e starts.
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
| P1 Install gate, wizard, settings, mode-1 auth, shell | next |
| P2 Mode-2 pizzasys auth · P3 Widgets/loader/builder | planned (parallel) |
| P4 Chat core · P5 Presence/notifications · P6 WhatsApp · P7 Analytics/hardening · P8 Deploy/QA/deck | planned |
