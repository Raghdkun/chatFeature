# Deployment on Hostinger KVM

> Status: skeleton to be completed in P8. Topology and checklists below come from the plan; nothing here has been run yet.

## Planned Docker Compose topology (`compose.prod.yml`)

| Service | Role | Notes |
|---|---|---|
| `caddy` | Reverse proxy, automatic HTTPS | Public ports 80/443; proxies the app and Reverb (wss) |
| `app` | PHP-FPM web app | Multi-stage Dockerfile; prints `SETUP_TOKEN` on first boot |
| `queue` | Queue worker | Same image as `app` |
| `scheduler` | `schedule:run` loop | Idle sweep, presence sweep, rollups |
| `reverb` | Reverb websocket server | `nofile` ulimit raised, `ext-uv`, Redis scaling |
| `nats-consumer` | `chat:auth:consume-nats` | Supervised; only needed in pizzasys mode |
| `mysql` | MySQL **8.4** | Persistent volume |
| `redis` | Redis **7**, AOF on | Cache, queue, sessions, presence |
| `openwa` | WhatsApp gateway | Image **pinned by digest**, internal network only |
| `nats` | Optional NATS server | Compose profile; only if you do not use pizzasys's NATS |

Dev uses `docker/compose.dev.yml` (MySQL, Redis, NATS profile, Mailpit) instead (P0).

## Sizing guidance

TBD in P8, after the P7 load test. One known input: the default OpenWA engine (`whatsapp-web.js`) needs about 300-500 MB RAM per WhatsApp session.

## Pre-flight checklist

- [ ] DNS A/AAAA record for the chat domain points at the KVM IP (Caddy needs it for certificates)
- [ ] Firewall allows 22, 80, 443 only; MySQL, Redis, OpenWA, NATS stay on the internal network
- [ ] Docker + Compose installed; SMTP credentials ready (offline-ticket email)
- [ ] For pizzasys mode: service-client token and prod (and optional test) domain from the portal admin
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
| `APP_KEY`, `APP_URL`, `APP_ENV=production`, `APP_DEBUG=false` | Core |
| `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | MySQL |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_CLIENT` | Redis |
| `SESSION_DRIVER`, `CACHE_STORE`, `QUEUE_CONNECTION` | Real drivers (activate once installed) |
| `BROADCAST_CONNECTION=reverb`, `REVERB_APP_ID`, `REVERB_APP_KEY`, `REVERB_APP_SECRET`, `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` | Reverb |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push |
| `MAIL_*` | SMTP |
| `OPENWA_*` (URL, API key; exact names set in P6) | OpenWA client |
| `SSRF_ALLOWED_HOSTS` | **On the OpenWA container**: allow the app host as a webhook target |
| `SETUP_TOKEN` | Optional: pre-set instead of reading it from the logs |

The pizzasys base URL, service name/token and NATS URL/credentials are stored (encrypted) in `auth_environments` by the wizard, not in `.env`.

## Open items for P8

- [ ] Dockerfile + `compose.prod.yml`
- [ ] Sizing table
- [ ] Backup targets (MySQL, storage volume, OpenWA data volume) and restore drill ([runbook.md](runbook.md))
- [ ] Clean-machine verification over HTTPS
