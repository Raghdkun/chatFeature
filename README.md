# PNE Chat

> Status: Phases 0-4 are done (install gate, setup wizard, both auth modes, categories, agents, widgets with loader and builder, and the live chat: routing with first-accept, realtime over Reverb, the agent inbox and the visitor panel). Presence/notifications (P5), WhatsApp (P6), analytics/hardening (P7) and deployment/QA/deck (P8) are next. The roadmap below is the source of truth.

PNE Chat is a self-hosted, tawk.to-style live-chat platform. A website visitor clicks an embeddable bubble, picks a support topic, an agent accepts, and a live chat starts. WhatsApp (through the self-hosted [OpenWA](https://www.open-wa.org) gateway) is an optional second channel. Admins run everything from a shadcn dashboard; agents only see the chats assigned to them. "PNE Chat" is a working name and can be renamed in Settings.

## Features (built through P4, the rest planned; see the roadmap)

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

### P1 Install + shell (done, `v0.1.0`)
- [x] 1A backend: `InstallState`/`InstallGate`/`InstallRunner` + steps, setup-token guard, typed encrypted settings, audit log, `AuthModeManager` + `FortifyDriver` + `LocalRoleResolver`, `Gate::before`, session-validity + chat-access middleware, role flags on `users`, `chat:install` / `chat:bootstrap-secrets` / `chat:install:reset`
- [x] 1B frontend: wizard (token, environment check, mode, admin, basics, install, done), role-aware shell/nav, `useTrans` + RTL plumbing (`en` + partial `ar`), login variants, role-aware dashboard stub, `welcome` replaced by auth redirect
- [x] 1C tests: Playwright e2e (desktop + mobile, axe WCAG A/AA clean, RTL, 375px)
- [x] Code review (10 findings, all fixed) and a manual security pass; e2e found and fixed 4 more bugs
- Exit met: empty DB boots to `/setup`; wizard completes mode 1; `/setup` is 404 after; `/` goes to login.
- Known gaps (backlog): `lang/ar.json` is a partial seed (29/150 keys); a throttled setup-token submit shows Inertia's generic error modal; the environment checklist is only revisitable via Back after the token step.

### P2 Mode-2 auth (done, `v0.2.0`; developed in parallel with P3)
- [x] 2A `PizzasysDriver`/Client/circuit breaker/`ShadowUserSync`/role resolver/`EnsureSessionIsValid`/Sanctum bridge/env model + wizard mode-2 steps (service token re-entry, pre-flight test, outbound address guard, one live identity per user and environment)
- [x] 2B NATS consumer (`chat:auth:consume-nats`, dead-letter file, TLS verification), `chat:auth:switch-env` / `set-env` / `test` / `reactivate` / `prune-*`, fixtures
- [x] 2C pizzasys test mock, a local clone of the real pizzasys as the e2e harness (outside the repo, not Docker), Settings > Auth page, portal login variant
- [x] Review and hardening round: setup-token takeover guard, SSRF guard, session revocation and degrade (`503 auth_unavailable`), login throttles, secrets never flashed or logged
- Exit met: feature tests (ok/invalid/unavailable/no-role/cache/revoked/degraded/service-token-rejected/env flip); NATS tests; mode-2 e2e against the real pizzasys clone ([auth-modes](docs/auth-modes.md), [findings](docs/pizzasys-findings.md)).
- Known gaps: **a real NATS server was never exercised** (the integration test is skipped without `NATS_TEST_URL`); the pizzasys facts come from a local clone, not a production instance; "TLS first" NATS servers are unsupported by the client library.

### P3 Widgets (done, `v0.3.0`; developed in parallel with P2)
- [x] 3A backend: categories, widgets, domains, greetings, config schema, draft/publish, public config/availability, `/w/{key}.js`, `/embed/{key}` + CSP, origin matcher, identity verifier, rate limits
- [x] 3B loader: Shadow-DOM launcher, greeting scheduler + flip, precedence, JS API, bridge, Vitest, size-limit (<= 16 KB gz; was 15, the build is 15.65 KB)
- [x] 3C dashboard UI: widget list, builder with live preview, categories, agents, "my support categories", embed-code tab
- [x] Review and hardening round: strict origin/CORS/CSP rules, boot-trust checks in the loader, per-origin limits, identity `jti`
- [x] P3 e2e: builder, live preview, the real loader on a cross-origin host page, origin/CORS/CSP, rate limits, concurrency, escaping, axe/375px/RTL
- Exit (unit/feature level): origin/CORS/CSP/JWT/rate-limit tests, loader and builder Vitest suites. The exit item "bubble + flip + popup + JS API on a real cross-origin host page" is covered by the P3 e2e.
- Known gaps: `availability.online` was false until P4 (presence-based now); the built-in public-suffix list used to reject `*.co.uk`-style wildcards is partial; the loader is at 15.65 KB of its 16 KB budget; `init.boot.categories` loses description/icon/colour in the loader.
- Gate at `v0.3.0` (P1-P3 together): `composer ci:check` green with PHPUnit **1667** (7 skip without a harness or a NATS server) and Vitest **1193** (the loader's tests under `resources/widget/test` are part of that run); Playwright **483** specs (480 pass, 3 skipped, 0 failed; mode 1, mode 2 against the local pizzasys clone, and P3).

### P4 Chat core (done, `v0.4.0`)
- [x] Spine: schema, enums, models, state machine, policy, visitor tokens, Data classes, domain events, shared TypeScript helpers
- [x] 4A domain + APIs: routing with waves and first-accept claim, messages, attachments pipeline, idle/expiry/rating sweeps, offline tickets, transfer, export, minimal presence
- [x] 4B realtime: Reverb, channel auth, visitor broadcasting auth, events, failure isolation, runtime address for the dashboard
- [x] 4C dashboard: inbox with queue/offers, conversation view, composer, typing/receipts, end/transfer, history, offline tickets
- [x] 4D embed panel: pre-chat, topics, queue, chat, rating, offline form, attachments, protocol with the loader
- [x] Independent reviews (backend correctness, security, frontend, front/back audit) and their fix rounds; real-stack e2e (visitor flows, staff and permission matrices, a11y/responsive/RTL/keyboard/perf, polling-only mode) and the deck screenshots
- Exit met: two-browser (here: five-actor) Playwright lifecycle against a real Reverb; MySQL concurrent-accept race test; idle auto-close; queue timeout to offline ticket; upload abuse tests; reconnect sync; IDOR/channel matrices.
- Gate at `v0.4.0`: `composer ci:check` green with PHPUnit **<<PHPUNIT>>** (14 skip without a harness, NATS or MySQL) and Vitest **<<VITEST>>**; Playwright **<<PW>>**.
- Known gaps: see the changelog (animated GIFs refused, stale sockets after revocation until reconnect, English-only inbox strings and system lines, no captcha hook, loader at 15.8 of 16 KB).

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
npm run build:widget      # the embeddable loader (public/widget/v1/loader.js); not part of `npm run build`
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
4. Mode 2 keeps working if the portal or NATS is briefly down (grace window, circuit breaker); beyond the grace window requests answer `503` and keep the session, and Settings > Auth stays reachable so the address or token can be repaired. Break-glass commands exist (`chat:auth:set-env`, `chat:auth:switch-env`, `chat:auth:reactivate`).
5. Details: [docs/auth-modes.md](docs/auth-modes.md).

## Embed snippet

```html
<script async src="https://chat.example.com/w/wk_xxxxxxxxxxxxxxxxxxxx.js" data-position="left"></script>
```

The loader is built with `npm run build:widget` (git-ignored output; check the size budget with `npm run size`). The chat panel behind the bubble arrives in P4. See [docs/widget-embed-api.md](docs/widget-embed-api.md).

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
| [docs/security.md](docs/security.md) | Threat model summary, implemented controls through P3, open hardening items |
| [docs/testing.md](docs/testing.md) | Test layers, commands, phase gate |
| [docs/deployment-hostinger-kvm.md](docs/deployment-hostinger-kvm.md) | Docker Compose topology and environment checklist (skeleton until P8) |
| [docs/runbook.md](docs/runbook.md) | Operations: auth portal and NATS, break-glass, loader serving (rest is P7/P8) |
| [docs/changelog.md](docs/changelog.md) | Keep a Changelog |

`docs/contracts/*` (Inertia shared props, event payloads, REST shapes, postMessage protocol, widget config, auth) is written by the orchestrator before each phase fans out and updated to the implemented truth afterwards ([docs/contracts/README.md](docs/contracts/README.md)).

## How this project is kept up to date

After every phase the gate runs: tests (`composer test`, type checks, lint, Vitest, Playwright smoke), then `/code-review`, `/security-review` and `/simplify`. Then `CLAUDE.md`, this roadmap, the relevant `docs/*.md` and `docs/changelog.md` are updated, and a tagged commit (`phase-N: <summary>`, `v0.N.0`) is made. Nothing is pushed to a remote unless asked.
