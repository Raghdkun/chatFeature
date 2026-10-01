# Changelog

> Status: living document; updated at the end of every phase gate.

All notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses phase tags `v0.N.0` until `v1.0.0` (P8).

## [Unreleased]

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
