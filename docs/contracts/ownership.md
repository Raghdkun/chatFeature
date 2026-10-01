# File ownership map

> Status: living. Parallel tracks edit **only** the paths they own; shared files belong to the orchestrator.

## Orchestrator-owned (tracks request changes)

`bootstrap/app.php`, `bootstrap/providers.php`, `composer.json`, `composer.lock`, `package.json`,
`package-lock.json`, `vite.config.ts`, `.env.example`, `docs/contracts/*`, `CLAUDE.md`, `README.md`,
`docs/changelog.md`, `.github/**`.

## Conflict-free extension points (created in P0)

| Need | Add a file here (never edit a shared list) |
|---|---|
| Web routes | `routes/web/<context>.php` (auto-loaded by `RouteFiles` from `routes/web.php`) |
| Management API routes (`/api/v1`, Sanctum) | `routes/api/management/<context>.php` |
| Public visitor API routes (`/api/v1/public`, bearer-only `widget` group) | `routes/api/public/<context>.php` |
| Webhooks (`/webhooks`) | `routes/webhooks/<context>.php` |
| Service bindings / boot logic | `app/Providers/<Context>ServiceProvider.php` (already registered) |
| Sidebar navigation | `resources/js/nav/<NN>-<context>.ts` default-exporting `NavEntry[]` (see `resources/js/nav/index.ts`) |
| Shared payload shapes | `app/Data/<Context>/*.php` + `#[TypeScript]`, then `composer types:generate` |
| Migrations | reserved timestamp block per phase: P1 `2026_10_10_*`, P2 `2026_10_20_*`, P3 `2026_10_30_*`, P4 `2026_11_10_*`, P5 `2026_11_20_*`, P6 `2026_11_25_*`, P7 `2026_12_01_*` |
| shadcn components | all pre-installed in P0 under `resources/js/components/ui/`; do not re-run the shadcn CLI |

## Per-context ownership (code lives under these roots)

| Context | PHP | Frontend |
|---|---|---|
| Install / Settings / Audit | `app/Domain/{Install,Settings,Audit}` | `resources/js/pages/setup`, `resources/js/pages/settings` |
| Auth | `app/Auth/**` | `resources/js/pages/auth`, `resources/js/pages/settings/auth.tsx` |
| Catalog / Widgets | `app/Domain/{Catalog,Widgets}` | `resources/js/pages/{categories,widgets,agents}`, `resources/js/components/widgets` |
| Visitors / Chat | `app/Domain/{Visitors,Chat}` | `resources/js/pages/{inbox,history,offline-tickets}`, `resources/js/components/chat`, `resources/js/embed` |
| Presence / Notifications | `app/Domain/{Presence,Notifications}` | `resources/js/components/notifications`, `public/sw.js` |
| WhatsApp | `app/Domain/WhatsApp`, `app/Infrastructure/OpenWa` | `resources/js/pages/whatsapp`, `resources/js/embed/channels` |
| Widget loader | `app/Http/Controllers/Embed` | `resources/widget/**` (own Vite config) |
| Analytics | `app/Domain/Analytics` | `resources/js/pages/analytics` |

Tests mirror the structure: `tests/Feature/<Context>/*`, `tests/Unit/<Context>/*`, `e2e/<context>/*`.
