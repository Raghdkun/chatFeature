# Deployment on Hostinger KVM

> Status: skeleton to be completed in P8. Topology and checklists below come from the plan, extended with what P2/P3 added (NATS consumer, loader build, new variables); no Dockerfile or `compose.prod.yml` exists yet and nothing here has been run on a server.

## Planned Docker Compose topology (`compose.prod.yml`)

| Service | Role | Notes |
|---|---|---|
| `caddy` | Reverse proxy, automatic HTTPS | Public ports 80/443; proxies the app and Reverb (wss) |
| `app` | PHP-FPM web app | Multi-stage Dockerfile (below); prints `SETUP_TOKEN` on first boot |
| `queue` | Queue worker | Same image as `app` |
| `scheduler` | `schedule:run` loop (every minute) | `chat:auth:prune-sessions` (daily 03:30) today; idle sweep, presence sweep, rollups later |
| `reverb` | Reverb websocket server | `nofile` ulimit raised, `ext-uv`, Redis scaling |
| `nats-consumer` | `php artisan chat:auth:consume-nats --instance=main` | Supervised (`restart: unless-stopped`); only useful in pizzasys mode with a NATS address saved in Settings > Auth, otherwise it idles harmlessly. Same image; restart it after code/`.env` changes ([runbook](runbook.md)) |
| `mysql` | MySQL **8.4** | Persistent volume |
| `redis` | Redis **7**, AOF on | Cache, queue, sessions, presence |
| `openwa` | WhatsApp gateway | Image **pinned by digest**, internal network only |
| `nats` | Optional NATS server | Compose profile; only if you do not use pizzasys's NATS |

Dev uses `docker/compose.dev.yml` (MySQL, Redis, NATS profile, Mailpit) instead (P0).

### Dockerfile plan (P8)

Multi-stage, one image for `app`, `queue`, `scheduler`, `reverb` and `nats-consumer`:
1. **composer** stage: `composer install --no-dev --optimize-autoloader` (this also drops Scribe and its public `/docs` route).
2. **node** stage: `npm ci`, **`npm run build` and `npm run build:widget`**. The loader `public/widget/v1/loader.js` is git-ignored build output; an image without it serves a "bundle not built" stub on `/widget/v1/loader.js`. Add `npm run size` (18 KB gzip budget) as a build check.
3. **runtime** stage: PHP-FPM with `ext-pcntl` (graceful consumer shutdown), `ext-curl` (the SSRF guard pins the validated address through curl), `ext-intl` (domain whitelist punycode), `ext-uv` for Reverb; copies `public/build` and `public/widget`.
Caddy serves `public/` statically (including `/widget/v1/loader.js`, see the caching note in the [runbook](runbook.md)) and sends everything else, notably `/w/*`, `/embed/*`, `/c/*`, `/api/*`, to PHP; Reverb is proxied as wss.

## Sizing guidance

TBD in P8, after the P7 load test. One known input: the default OpenWA engine (`whatsapp-web.js`) needs about 300-500 MB RAM per WhatsApp session.

## Pre-flight checklist

- [ ] DNS A/AAAA record for the chat domain points at the KVM IP (Caddy needs it for certificates)
- [ ] Firewall allows 22, 80, 443 only; MySQL, Redis, OpenWA, NATS stay on the internal network
- [ ] Docker + Compose installed; SMTP credentials ready (offline-ticket email)
- [ ] For pizzasys mode: service-client token and prod (and optional test) domain from the portal admin; if the portal or its NATS server lives on a private network (Docker network, VPN) plan `PORTAL_ALLOW_PRIVATE_HOSTS=true`
- [ ] The customer sites that will embed the widget: their https origins go into each widget's domain whitelist (a bare entry admits https only)
- [ ] For WhatsApp: a dedicated phone number and a phone to scan the QR (ban-risk warning, see [whatsapp-openwa.md](whatsapp-openwa.md))

## First run

1. `docker compose -f compose.prod.yml up -d`
2. Read the one-time **`SETUP_TOKEN`** from `docker compose logs app`.
3. Open `https://<domain>/setup`, enter the token, complete the wizard ([auth-modes.md](auth-modes.md)).
4. After the lock is written `/setup/*` returns 404; log in at `/`.
5. Verify HTTPS, websocket connection and a restart (the stack must survive `docker compose restart`).

## Environment variable checklist

| Variable | Purpose |
|---|---|
| `APP_KEY`, `APP_URL`, `APP_ENV=production`, `APP_DEBUG=false` | Core. Keep `APP_ENV=production`: the setup token is skipped only for `APP_ENV=local` requests from loopback. |
| `TRUSTED_PROXIES` (Caddy's address list, or `*` on the internal compose network) | **Required behind Caddy**: real client IP, scheme and host for rate limiters, audit log, secure cookies and generated URLs. Empty = trust nothing. |
| `SESSION_SECURE_COOKIE=true`, `SESSION_SAME_SITE=lax` | Session cookie hardening (HTTPS only). |
| `SANCTUM_EXPIRATION_MINUTES` (default 43200 = 30 days) | Lifetime of staff API tokens (mobile app). |
| `SETUP_TOKEN` | One-time takeover guard for `/setup` (printed by `chat:bootstrap-secrets` / `docker compose logs app`, or pre-set); the wizard refuses to start without one. Not needed after install. |
| `INSTALL_*` | Only for the non-interactive `chat:install` (admin e-mail/password, app name/URL, mode-2 portal address, service token, portal admin login...). **Remove them after the install.** |
| `PORTAL_ALLOW_PRIVATE_HOSTS` (default `false`) | Set `true` ONLY when the pizzasys portal / its NATS server live on a private network (Docker network, VPN): the app otherwise refuses loopback, private, CGNAT and link-local targets for those addresses. |
| `NATS_TLS_CA_FILE` | CA bundle the NATS server certificate is verified against (empty = system store). The other `NATS_*` variables only feed dev/test; in production the NATS address and token are saved per environment in Settings > Auth. |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | MySQL |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_CLIENT` | Redis |
| `SESSION_DRIVER`, `CACHE_STORE`, `QUEUE_CONNECTION` | Real drivers (activate once installed). The cache must be shared by every process (Redis): verify results, rate limits and the widget cache namespaces live in it. |
| `BROADCAST_CONNECTION=reverb`, `REVERB_APP_ID`, `REVERB_APP_KEY`, `REVERB_APP_SECRET`, `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` | Reverb |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push |
| `MAIL_*` | SMTP |
| `OPENWA_*` (URL, API key; exact names set in P6) | OpenWA client (unchanged by P2/P3) |
| `SSRF_ALLOWED_HOSTS` | **On the OpenWA container**: allow the app host as a webhook target (unchanged) |

The public URL that widgets use is the **`app.url` setting saved by the wizard** (not `APP_URL`, not the request's Host header): snippets, boot configs and the loader's postMessage origin derive from it, so set it to the final `https://` origin in the wizard's basics step.
The pizzasys base URL, service name/token and NATS URL/credentials are stored (encrypted) in `auth_environments` by the wizard, not in `.env`.

## Open items for P8

- [ ] Dockerfile (plan above, including `npm run build:widget`) + `compose.prod.yml`
- [ ] Caddyfile: static `public/`, short cache for `/widget/v1/loader.js`, everything else to PHP, wss for Reverb, optional rate limit/WAF in front of the public widget endpoints (P7)
- [ ] Sizing table
- [ ] Backup targets (MySQL, storage volume, OpenWA data volume) and restore drill ([runbook.md](runbook.md))
- [ ] Clean-machine verification over HTTPS

## Hardening notes carried over from earlier phases

- Scribe (`knuckleswtf/scribe`) is a **dev** dependency and registers a public `/docs` route; production images are built with `composer install --no-dev`, which removes it. If API docs are ever served in production, put them behind auth (P7).
- Do not run `php artisan config:cache` before `SETUP_TOKEN` / `INSTALL_*` exist in the environment: cached config ignores later `env()` changes. After any environment change re-run it and restart workers, scheduler and the NATS consumer ([runbook](runbook.md)).
- `storage/app/install-state.json` and `installed.lock` must live on a persistent volume (the lock is what keeps `/setup` closed).

