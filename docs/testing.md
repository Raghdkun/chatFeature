# Testing

> Status: partially live. PHP checks and `vp`/`tsc` scripts exist in the starter kit; Vitest, Playwright, size-limit, axe, k6 are planned (P0 tooling, used from P1+).

## Test layers

| Layer | Tool | Covers | Status |
|---|---|---|---|
| PHP style | Pint (`pint --test`) | Code style | available |
| PHP static analysis | Larastan / PHPStan (`phpstan analyse`) | Types | available |
| PHP feature/unit | PHPUnit via `artisan test` (SQLite for speed) | Actions, controllers, gates, drivers | available |
| MySQL-only tests | PHPUnit on MySQL in CI | Concurrent-accept race, unique-NULL trap | planned P4 |
| Frontend lint/format | `vp check` (`npm run check`) | TS/React lint + format | available |
| Types | `tsc --noEmit` (`npm run types:check`) | TypeScript | available |
| Frontend unit | Vitest (+ MSW until backend merges) | Loader precedence, fake-timer greeting scheduler, reduced motion, postMessage origin checks | planned P0/P3 |
| Bundle budget | size-limit | Loader <= 15 KB gz | planned P3 |
| E2E | Playwright (chromium/webkit/firefox + iPhone/Pixel profiles) | Install wizard, two-browser chat lifecycle, cross-origin embed | planned P1/P4/P8 |
| Integration | Docker `nats -js`, real pizzasys clone, real OpenWA image | NATS idempotency/deactivation, token TTL, QR to ready, recorded fixtures | planned P2/P6 |
| Security matrices | PHPUnit/Playwright | Channel-auth, visitor IDOR, agent isolation (403), CORS/CSP/origin, upload abuse (spoof/oversize/EXIF/SVG) | planned P3-P7 |
| Accessibility / perf | axe, Lighthouse, k6 | a11y, best-practices >= 95, ~1k sockets | planned P7/P8 |

## Running the checks

```bash
composer test          # artisan config:clear + pint --test + phpstan + artisan test
composer lint          # pint --parallel (fix)    | composer lint:check (verify only)
composer types:check   # phpstan analyse
npm run check          # vp check (lint/format)   | npm run check:fix
npm run types:check    # tsc --noEmit
composer ci:check      # npm run check + npm run types:check + composer test
```

The kit's GitHub Actions workflow (`.github/workflows/tests.yml`) runs `composer setup` then `composer ci:check`. Vitest and Playwright commands will be added to `package.json` in P0/P1 and documented here.

## Gate checklist (end of every phase)

1. `composer test` (pint + larastan + phpunit), `tsc`, lint, Vitest, Playwright smoke all green.
2. `/code-review` at high effort; fix findings.
3. `/security-review`; fix findings.
4. `/simplify`.
5. Update `CLAUDE.md` (via `claude-md-management:revise-claude-md`), the README roadmap checkboxes, the relevant `docs/*.md` and `docs/changelog.md`.
6. Commit `phase-N: <summary>` and tag `v0.N.0`. No push unless asked.

## Notable exit tests per phase

| Phase | Must be proven |
|---|---|
| P1 | Gate/503/lock idempotency, setup token, concurrent install run, driver switch, RTL snapshot |
| P2 | ok/invalid/unavailable/no-role/cache/revoked/degraded/service-token-rejected/env flip; NATS replay + deactivation; real-pizzasys run documented |
| P3 | Cross-origin host page; origin/CORS/CSP/JWT (valid/expired/forged); builder preview equals real widget |
| P4 | Concurrent-accept race (MySQL); idle auto-close; queue timeout to offline ticket; reconnect sync; attachment abuse; IDOR matrices |
| P5 | Presence across hidden/closed tab; OS notification only when unfocused; push delivery by logs + manual checklist |
| P6 | Signature valid/tampered/missing/replay; linking; agent isolation 403; real-device round trip |
| P7 | Analytics reconcile with raw data; headers grade A; no cross-widget/visitor access; load results |
| P8 | Clean-machine compose run over HTTPS; restore drill; Lighthouse/axe recorded |
