# Runbook

> Status: skeleton, filled in during P7/P8. Commands marked "planned" do not exist yet.

## Health checks

- `GET /up` is exempt from the install gate and answers even before setup.
- Before install, API routes return `503 not_installed` by design.
- Planned: per-service checks in compose (`mysql`, `redis`, `reverb`, `queue`, `openwa`).
- [ ] TBD (P8): list of probes and expected output

## Logs

- App/queue/reverb/consumer logs: `docker compose logs -f <service>`.
- First-run setup token: `docker compose logs app`.
- Local dev: `php artisan pail` (Laravel Pail is in the kit).
- [ ] TBD (P8): log retention and rotation

## Backups and restore drill

Targets: MySQL, the storage volume (attachments, `installed.lock`), the OpenWA data volume (WhatsApp session), `.env`.
- [ ] TBD (P8): backup schedule, commands, off-box storage
- [ ] TBD (P8): restore drill procedure and last-run date (exit criterion: drill passes)

## Upgrades and rollback

- [ ] TBD (P8): pull/migrate/restart order, `migrate --force`, asset rebuild
- [ ] TBD (P8): rollback procedure, including migrations and the pinned OpenWA digest

## Break-glass

| Situation | Command (planned) |
|---|---|
| Portal down or wrong environment active (pizzasys mode) | `php artisan chat:auth:switch-env` |
| Non-interactive install (Docker/e2e) | `php artisan chat:install --mode=local\|pizzasys` |
| Locked out in pizzasys mode | Degraded grace window (30 min), then switch env via the CLI above |

See [auth-modes.md](auth-modes.md).

## Re-pairing WhatsApp

1. Admin opens Settings > WhatsApp, restarts the session (`POST /api/sessions/{id}/start` on OpenWA).
2. Scan the QR (`GET /api/sessions/{id}/qr`) with the dedicated phone.
3. Confirm the webhook is still registered and the secret matches ([whatsapp-openwa.md](whatsapp-openwa.md)).
- [ ] TBD (P6/P8): exact UI steps and failure signs

## Queue, Reverb and NATS troubleshooting

- Queue: `php artisan queue:listen` (dev) or the `queue` service; failed jobs in `failed_jobs`.
- Reverb: `php artisan reverb:start`; check `nofile` ulimit and `ext-uv` if connections drop under load.
- NATS consumer: `chat:auth:consume-nats` (planned); the app keeps working if it is down, revocation lag is at most `verify_ttl` (120 s).
- [ ] TBD (P4/P5/P8): symptom -> cause table

## Load-test results

TBD in P7 (k6, about 1k concurrent sockets): record date, hardware, p50/p95 latency, connection count, and fd/CPU/RAM limits. See [realtime.md](realtime.md).
