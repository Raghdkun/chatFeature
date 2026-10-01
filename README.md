# PNE Chat

> Status: Phase 0 (scaffold) in progress. Only the stock starter kit plus dependencies exists; everything below the roadmap is design.

PNE Chat is a self-hosted, tawk.to-style live-chat platform. A website visitor clicks an embeddable bubble, picks a support topic, an agent accepts, and a live chat starts. WhatsApp (through the self-hosted [OpenWA](https://www.open-wa.org) gateway) is an optional second channel. Admins run everything from a shadcn dashboard; agents only see the chats assigned to them. "PNE Chat" is a working name and can be renamed in Settings.

## Features (planned)

- **Embeddable widget**: tiny Shadow-DOM launcher + iframe chat panel, script/iframe/hosted-page embeds, JS API, signed visitor identity, domain whitelist.
- **Creative greeting**: weighted-random greeting pool, 3D-flip launcher to the agent face, popup, auto-hide, reduced-motion safe.
- **Routing**: new request is offered to all online agents owning the category; first Accept wins (atomic claim); no agent online becomes an offline ticket answered by email.
- **Realtime chat**: Laravel Reverb, typing, delivered/seen receipts, image attachments, ratings, reconnect sync.
- **Notifications**: Web Push (VAPID), in-tab sound, title/favicon badge, presence with auto-away.
- **WhatsApp (optional)**: `wa.me` hand-off with ticket code, every message recorded, admin-only inbox. Agents never see WhatsApp chats.
- **Two auth modes** chosen once in a setup wizard (see below).
- **Dashboard**: widget builder with live preview, categories, agents, history search/export, analytics, audit log.
- **Open API**: one versioned `/api/v1` serves the dashboard and a future mobile app.
- **i18n + RTL ready**, responsive on every screen, Docker Compose + Caddy deployment for Hostinger KVM.

## Tech stack

| Layer | Choice |
|---|---|
| Backend | Laravel 13 (PHP 8.4 locally, `composer.json` allows `^8.3`), Fortify, Sanctum, Reverb 1.12 |
| Frontend | Inertia 3, React 19, TypeScript, Tailwind 4, shadcn/ui, Wayfinder, Vite 8 (`vp` / Vite+) |
| Realtime | Reverb (Pusher protocol), `laravel-echo`, `@laravel/echo-react`, `pusher-js`, Redis scaling |
| Data | MySQL 8 (SQLite for quick tests), Redis |
| Push | `laravel-notification-channels/webpush` (VAPID), FCM stub for the future mobile app |
| Images | `intervention/image` (re-encode uploads, strip EXIF) |
| Auth integration | `basis-company/nats` (NATS JetStream consumer for the pizzasys mirror) |
| WhatsApp | OpenWA (`ghcr.io/rmyndharis/openwa`) over REST + HMAC-signed webhooks |
| Deploy | Docker Compose + Caddy (auto-HTTPS) |

## Roadmap

Map: `P0 -> P1 -> {P2 || P3} -> P4 -> {P5 || P6} -> P7 -> P8`. One commit per phase, tagged `v0.N.0`.

### P0 Scaffold (done, `v0.0.0`)
Goal: starter kit and tooling. Exit: stock kit boots; SQLite (tests) and MySQL both migrate; `composer ci:check` green.
- [x] Laravel 13 React starter kit scaffolded; git initialised (`main`)
- [x] Sanctum, Reverb, WebPush, Intervention Image, NATS client installed (Echo + pusher-js on the JS side); Guzzle pinned to 7 for Reverb
- [x] Laravel Boost installed (guidelines in `AGENTS.md`, MCP in `.mcp.json`); `CLAUDE.md` v0 imports it
- [x] Kit tooling inspected (`vp` = Vite+: build/test/check; chisel only stripped its own markers) and recorded in `CLAUDE.md`
- [x] Scribe; JS tooling: zod, Vitest (`vp test`), Playwright, size-limit, axe, msw, jsdom
- [x] spatie/laravel-data + typescript-transformer spike: works on Laravel 13 (`composer types:generate`)
- [x] Per-context ServiceProviders, conflict-free route loaders (`RouteFiles`), bearer-only `widget` middleware group, nav registry
- [x] All shadcn components pre-installed (kit files untouched)
- [x] `docker/compose.dev.yml` (Mailpit, NATS, OpenWA, optional MySQL/Redis profiles); CI runs Vitest
- [x] README roadmap, `docs/` stubs, `docs/contracts/` (shared props, install steps, file ownership)

### P1 Install + shell
- [ ] 1A backend: InstallState/Gate/Runner, typed settings, audit, `AuthModeManager` + `FortifyDriver`, gates
- [ ] 1B frontend: wizard pages, role-aware shell/nav, `useTrans`, RTL plumbing, `welcome` replaced by auth redirect
- [ ] 1C tests/docs: Playwright harness, install e2e
- Exit: empty DB boots to `/setup`; wizard completes mode 1; `/setup` is 404 after; `/` goes to login.

### P2 Mode-2 auth (parallel with P3)
- [ ] 2A `PizzasysDriver`/Client/circuit breaker/`ShadowUserSync`/role resolver/`EnsureSessionIsValid`/Sanctum bridge/env model + wizard mode-2 steps
- [ ] 2B NATS consumer, `chat:auth:switch-env`, fixtures
- [ ] 2C pizzasys mock + Docker clone of real pizzasys, Settings > Auth page, portal login variant
- Exit: feature tests (ok/invalid/unavailable/no-role/cache/revoked/degraded/service-token-rejected/env flip); NATS tests; real-pizzasys run documented ([auth-modes](docs/auth-modes.md)).

### P3 Widgets (parallel with P2)
- [ ] 3A backend: categories, widgets, domains, greetings, config schema, draft/publish, public config/availability, `/w/{key}.js`, `/embed/{key}` + CSP, origin matcher, identity verifier
- [ ] 3B loader: Shadow-DOM launcher, greeting scheduler + flip, precedence, JS API, bridge, Vitest, size-limit (<= 15 KB gz)
- [ ] 3C dashboard UI: widget list, builder with live preview, categories, agents, embed-code page
- Exit: bubble + flip + popup + JS API on a cross-origin host page; origin/CORS/CSP/JWT tests; builder preview matches the real widget.

### P4 Chat core
- [ ] 4A domain + APIs: state machine, routing, claim, messages, attachments pipeline, idle/expiry jobs, offline tickets
- [ ] 4B realtime: Reverb, channel auth, visitor guard, events, echo/sync helpers
- [ ] 4C dashboard: queue/offers, claim UX, conversation list/detail, composer, typing/receipts, end/transfer, admin history
- [ ] 4D embed panel: pre-chat, category picker, waiting, chat, offline form, rating, attachments, bridge
- Exit: two-browser Playwright lifecycle; MySQL concurrent-accept race test; idle auto-close; queue timeout to offline ticket; upload abuse tests; reconnect sync; IDOR matrices.

### P5 Presence + notifications (parallel with P6)
- [ ] 5A presence service, heartbeat, sweep, availability + UI
- [ ] 5B VAPID, `sw.js`, first-login permission flow, sound, badges, notification settings, manifest, `FcmChannel` stub
- [ ] 5C admin history search/export, widget unseen badge + reply alert
- Exit: presence correct across hidden/closed tab; OS notification only when the dashboard is not focused; streaming export.

### P6 WhatsApp (parallel with P5)
- [ ] 6A backend: OpenWA client, sessions, webhook + HMAC, dedupe, `ChatLinker`, hand-off, `SendReply`
- [ ] 6B UI: settings page with QR, admin-only inbox, widget channel chooser + `wa.me` hand-off
- [ ] 6C tests/ops: OpenWA mock, run against the real image to record fixtures, docs
- Exit: signature tests; linking tests; QR to ready on the real image; agent isolation (403 everywhere); real-device round trip documented.

### P7 Analytics + hardening
- [ ] 7A analytics rollups + charts
- [ ] 7B Scribe docs, OpenAPI export, mobile-readiness review
- [ ] 7C security sweep (CSP nonces, headers, rate-limit/CORS matrices, BOLA/IDOR, upload fuzzing, dependency audits, EXPLAIN review, k6 load test of about 1k sockets)
- Exit: analytics reconcile with raw data; Scribe builds; security headers grade A; load results in [runbook](docs/runbook.md).

### P8 Deploy + QA + docs + deck
- [ ] 8A multi-stage Dockerfile + `compose.prod.yml`
- [ ] 8B [deployment guide](docs/deployment-hostinger-kvm.md) + [runbook](docs/runbook.md) (backups, restore drill, upgrade, break-glass, re-pair WhatsApp)
- [ ] 8C QA matrix (chromium/webkit/firefox, iPhone/Pixel profiles, axe, Lighthouse, RTL pass)
- [ ] 8D PowerPoint deck with real screenshots
- Exit: prod compose runs the wizard end to end over HTTPS on a clean machine; restore drill passes; Lighthouse a11y/best-practices >= 95; tag `v1.0.0`.

## Quick start

Prerequisites: PHP 8.4, Composer, Node 24, MySQL, Redis.

```bash
composer setup            # install deps, .env, key, migrate, npm install + build
composer dev              # runs `php artisan dev` (framework dev-process runner)
php artisan reverb:start  # realtime server (separate terminal unless your dev runner already starts it)
php artisan queue:listen  # queue worker (same note)
```

Dev `.env` points at local MySQL (`DB_DATABASE=chatfeature`) and Redis. Once the install gate lands (P1), the **first run opens the setup wizard at `/setup`**; with `APP_ENV=local` no setup token is required, in production the token is printed in the app logs.

## Auth modes

Chosen once in the setup wizard, then locked.
1. **Mode 1 - Local**: starter-kit Fortify login (2FA/passkeys); admin/agent flags are edited in the dashboard.
2. **Mode 2 - pizzasys**: login is delegated to the external pizzasys portal; admin/agent are derived from its roles/permissions via a service client; users are mirrored as shadow users.
3. Both sit behind one `AuthDriver`; the app reads only `users.is_admin` / `users.is_agent`.
4. Mode 2 keeps working if the portal or NATS is briefly down (grace window, circuit breaker).
5. Details: [docs/auth-modes.md](docs/auth-modes.md).

## Embed snippet (planned, P3)

```html
<script async src="https://chat.example.com/w/wk_XXXX.js" data-position="left"></script>
```

See [docs/widget-embed-api.md](docs/widget-embed-api.md).

## Documentation

| Doc | Content |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Modular monolith, contexts, layout, request flows |
| [docs/auth-modes.md](docs/auth-modes.md) | Wizard, Fortify mode, pizzasys mode |
| [docs/pizzasys-findings.md](docs/pizzasys-findings.md) | Verified behaviour of the pizzasys auth service (local harness) |
| [docs/widget-embed-api.md](docs/widget-embed-api.md) | Embeds, JS API, postMessage, signed identity |
| [docs/rest-api.md](docs/rest-api.md) | Public + management API, conventions |
| [docs/whatsapp-openwa.md](docs/whatsapp-openwa.md) | OpenWA facts, hand-off, isolation |
| [docs/realtime.md](docs/realtime.md) | Channels, events, claim, sync, state machine |
| [docs/testing.md](docs/testing.md) | Test layers, commands, phase gate |
| [docs/deployment-hostinger-kvm.md](docs/deployment-hostinger-kvm.md) | Docker Compose topology (skeleton) |
| [docs/runbook.md](docs/runbook.md) | Operations (skeleton) |
| [docs/changelog.md](docs/changelog.md) | Keep a Changelog |

`docs/contracts/*` (Inertia shared props, event payloads, REST shapes, postMessage protocol) is written by the orchestrator before P1 fan-out.

## How this project is kept up to date

After every phase the gate runs: tests (`composer test`, type checks, lint, Vitest, Playwright smoke), then `/code-review`, `/security-review` and `/simplify`. Then `CLAUDE.md`, this roadmap, the relevant `docs/*.md` and `docs/changelog.md` are updated, and a tagged commit (`phase-N: <summary>`, `v0.N.0`) is made. Nothing is pushed to a remote unless asked.
