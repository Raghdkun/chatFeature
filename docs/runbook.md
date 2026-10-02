# Runbook

> Status: partly filled (auth portal, NATS consumer, break-glass, loader, install cleanup: written from the P2/P3 code); backups, upgrades, queue/Reverb and load results are filled in P7/P8. Commands marked "planned" do not exist yet. Anything marked *(unverified)* has not been run on a real deployment.

## Health checks

- `GET /up` is exempt from the install gate and answers even before setup.
- Before install, API routes return `503 not_installed` by design.
- Auth portal (mode 2): **Settings > Auth** shows portal health (ok / degraded / down), the circuit breaker, the last verification and the NATS consumer; `php artisan chat:auth:test [production|testing]` runs the same connection test from the shell (reachable, service credential, response time, NATS; exit code 1 on failure).
- Widget loader: `curl -s https://<domain>/widget/v1/loader.js | head -c 40` must start with `/*! pne-chat-loader v1 */`; anything else (a comment mentioning "bundle not built") means `npm run build:widget` did not run in the image.
- Planned: per-service checks in compose (`mysql`, `redis`, `reverb`, `queue`, `openwa`).
- [ ] TBD (P8): list of probes and expected output

## Logs

- App/queue/reverb/consumer logs: `docker compose logs -f <service>`.
- First-run setup token: `docker compose logs app`.
- Local dev: `php artisan pail` (Laravel Pail is in the kit).
- NATS events that could not be processed: `storage/logs/nats-dead-letter.ndjson` (metadata only, see below). Payloads are never logged.
- [ ] TBD (P8): log retention and rotation

## Backups and restore drill

Targets: MySQL, the storage volume (attachments, `installed.lock`, `install-state.json`), the OpenWA data volume (WhatsApp session), `.env`.
- [ ] TBD (P8): backup schedule, commands, off-box storage
- [ ] TBD (P8): restore drill procedure and last-run date (exit criterion: drill passes)

## Upgrades and rollback

Today's order (the compose files come in P8):
1. Pull the new code, `composer install --no-dev --optimize-autoloader`, `npm ci && npm run build && npm run build:widget` (**both** builds: `npm run build` does not produce the loader).
2. `php artisan migrate --force`, then `php artisan config:cache` (see the caveat below; route/view caching was not verified with this app).
3. Restart long-lived processes so they pick up the new code and config: queue worker, Reverb, **the NATS consumer**, PHP-FPM.
4. Check `/widget/v1/loader.js` and Settings > Auth health.
- [ ] TBD (P8): rollback procedure, including migrations and the pinned OpenWA digest

## Break-glass

| Situation | Command |
|---|---|
| Portal down or wrong environment active (pizzasys mode) | `php artisan chat:auth:switch-env production` (no network, `--force` skips the confirmation) |
| Wrong portal address / service name / token saved (nobody can use Settings > Auth) | `php artisan chat:auth:set-env production --base-url=... --token-file=...` (secret from a file or a hidden prompt, never argv; nothing is tried against the portal; a changed address or service name asks for the token again), then `php artisan chat:auth:test` |
| A person cannot sign in after a `user.deleted` event that was wrong | `php artisan chat:auth:reactivate <email or portal user id>` (`--env=`, `--force`) |
| Non-interactive install (Docker/e2e) | `php artisan chat:install --mode=local\|pizzasys` (reads `INSTALL_*`) |
| Locked out in pizzasys mode | The degraded grace window (30 min); beyond it Settings > Auth and sign-out stay reachable so an administrator can repair the address/token; otherwise the CLI above |
| Portal on a private network (Docker/VPN) is refused as an address | Set `PORTAL_ALLOW_PRIVATE_HOSTS=true` (never needed for a public portal), re-cache config, restart |
| Dev only: start the wizard again | `php artisan chat:install:reset` (`APP_ENV=local` only; wipes the database) |

See [auth-modes.md](auth-modes.md).

## Auth portal operations (mode 2)

**What users see when the portal is down.** Signed-in staff keep working for `auth.pizzasys.grace_minutes` (default 30) after their last successful verification. After that every request answers `503 auth_unavailable` (an HTML page for browsers, `Retry-After: 30`), **the session is kept**, so nobody is logged out and recovery is automatic once the portal answers. New sign-ins show "Auth Portal unreachable". Still reachable during the 503: sign-out and Settings > Auth (the page, saving/testing an environment, switching the active one), so a wrong address or token can be repaired from the dashboard. The role mapping is not reachable on purpose. Five failures within 30 s open a circuit breaker for 30 s, which spares the portal; only outages count (connect errors, timeouts, TLS failures, 5xx), never wrong passwords.

**Rotating the pizzasys service token.** The portal's service-token rotation has no overlap window ([pizzasys-findings.md](pizzasys-findings.md)): the old token stops working the moment the new one is issued. Existing sessions keep working through the `/auth/me` fallback (the health card shows "service credential rejected") but **new sign-ins are refused** until the new token is saved, so do the two steps back to back:
1. Rotate the token in the portal's admin (the service client registered for this app).
2. Settings > Auth > edit the environment > paste the new token > Save. The app first tries the submitted values against the portal and refuses to save a token the portal does not accept (field errors `service_token`/`base_url`, `connection`). Without UI access: `php artisan chat:auth:set-env production --token-file=/run/secrets/svc`. Then `php artisan chat:auth:test`.
Changing the address, the service name or the NATS address always asks for the matching token again (a stored secret is never sent to a new destination).

**Switching production/testing.** Settings > Auth > the environment switch: you must sign in as an administrator of the *target* portal. Everybody (you included) is signed out, the NATS consumer reconnects, an audit row is written. Without the UI: `chat:auth:switch-env`.

**Sessions that were never signed out.** Upstream tokens never expire, so `chat:auth:prune-sessions` (scheduled daily at 03:30 by the `scheduler` service; needs `schedule:run` every minute) revokes sessions that were not verified for longer than their lifetime plus an hour and logs that token out upstream.

## NATS consumer (supervised)

- Command: `php artisan chat:auth:consume-nats --instance=main` as its own long-running service (`nats-consumer`, `restart: unless-stopped` or supervisor/systemd). The durable consumer is named `pne-chat-<APP_ENV>-<instance>`: keep the instance name stable. Two processes with the same name share one durable and split the events between them; a new name creates a new durable that starts at "new" events (what was published while it was away is not replayed, which is acceptable because events are only hints). With `ext-pcntl` it finishes the current batch on SIGTERM/SIGINT.
- **It is optional**: sessions are re-verified against the portal every `verify_ttl_seconds` (default 60) anyway; NATS only makes revocations and role changes faster. The process idles (never crash-loops) while no NATS address is configured.
- **What switches it on:** the active environment's NATS address in Settings > Auth (the `auth.pizzasys.nats.enabled` setting follows it automatically). `NATS_ENABLED`, `NATS_URL`, `NATS_TOKEN`, `NATS_STREAM`, `NATS_ENSURE_STREAM`, `NATS_ENVIRONMENT_KEY` and `NATS_VERIFY_TLS` in `.env` are only a development/test fallback and have **no effect in production**. `NATS_TLS_CA_FILE` (CA bundle for the server certificate) does apply.
- Changing the NATS address or token, or switching environments, makes the consumer reconnect within 30 s (cache signal `auth.nats.restart`). It reconnects with back-off (1 to 60 s) after errors. A restart is only needed after code or `.env` changes.
- **Dead-letter file** `storage/logs/nats-dead-letter.ndjson`: one JSON line per event that could not be processed (`at`, `reason`, `event_id`, `type`, `subject`, `stream_sequence`, `deliveries`, `error`). Never the payload (it can contain a password hash). To inspect an event fetch the stream sequence from JetStream (`nats stream get AUTH_EVENTS <seq>`). Include the file in log rotation.
- TLS: the certificate and host name are verified (off only with the environment's "verify TLS" switch); a `tls://` address, or `nats://` to a public host, never falls back to plaintext. "TLS first" servers are not supported. *(Unverified: no real NATS server was ever run against the consumer; dev server: `docker compose -f docker/compose.dev.yml --profile nats up -d`.)*

## Widget loader

- The bundle `public/widget/v1/loader.js` is **built, not committed** (`npm run build:widget`, about 49 KB / 16.4 KB gzip, budget 18 KB: `npm run size`). The Docker image build must run it. `GET /w/{key}.js` is always served by PHP (it inlines the widget's boot config); `GET /widget/v1/loader.js` is a static file when it exists.
- Caching: PHP sends `Cache-Control: public, max-age=60, stale-while-revalidate=300` and an `ETag` that changes with the widget config and with the bundle, so a rebuild or a Publish reaches visitors within about a minute. The static file has no content hash in its name: let Caddy's `file_server` add `ETag`/`Last-Modified` and give it a short lifetime, for example `header /widget/v1/loader.js Cache-Control "public, max-age=300"` *(suggested, not yet run; settle it with the P8 Caddyfile)*. Do not cache `/w/*.js` or `/embed/*` longer in the proxy than PHP says.
- Serve `/w/*`, `/embed/*`, `/c/*` and `/api/*` to PHP; these routes must not get session cookies (they run without the web middleware group, so they never set one).
- If the file is missing PHP serves a stub that only logs a console warning, and the dashboard builder falls back to its static preview.

## After the install

- `INSTALL_*` variables (`INSTALL_ADMIN_PASSWORD`, `INSTALL_AUTH_SERVICE_TOKEN`, `INSTALL_AUTH_NATS_TOKEN`, `INSTALL_AUTH_ADMIN_PASSWORD`, ...) are read **only** by `chat:install`. Once the install succeeded, remove them from `.env`, the compose file and any secret store; the portal tokens live encrypted in `auth_environments` from then on. `SETUP_TOKEN` is not needed afterwards either (`/setup/*` is a 404 once `storage/app/installed.lock` exists; keep that file on a persistent volume).
- **`config:cache` caveat:** cached configuration ignores later `.env` changes. Run `config:cache` only after `SETUP_TOKEN` / `INSTALL_*` exist (and after the install if you install with `chat:install`), and after changing any environment variable run `php artisan config:cache` again and **restart the workers, the scheduler and the NATS consumer** (long-lived processes keep the old values). `chat:bootstrap-secrets` warns when a cached config exists.

## Re-pairing WhatsApp

1. Admin opens Settings > WhatsApp, restarts the session (`POST /api/sessions/{id}/start` on OpenWA).
2. Scan the QR (`GET /api/sessions/{id}/qr`) with the dedicated phone.
3. Confirm the webhook is still registered and the secret matches ([whatsapp-openwa.md](whatsapp-openwa.md)).
- [ ] TBD (P6/P8): exact UI steps and failure signs

## Queue, Reverb and NATS troubleshooting

- Queue: `php artisan queue:listen` (dev) or the `queue` service; failed jobs in `failed_jobs`.
- Reverb: `php artisan reverb:start`; check `nofile` ulimit and `ext-uv` if connections drop under load.

| Symptom | Likely cause / check |
|---|---|
| Settings > Auth says NATS "not connected" or the last event is old | Consumer not running (`docker compose ps nats-consumer`, its logs); no NATS address saved for the **active** environment; wrong token or certificate (`chat:auth:test` shows the NATS row); `NATS_TLS_CA_FILE` missing for a private CA |
| NATS address is refused when saving | It resolves to a private/loopback address and `PORTAL_ALLOW_PRIVATE_HOSTS` is not true, or the spelling is not canonical (use a plain host name or dotted IPv4) |
| Revocations or role changes take about a minute | No NATS (by design): revocation lag is at most `verify_ttl_seconds` |
| Everybody gets 503 `auth_unavailable` | Portal unreachable beyond the grace window, or our service token rejected: Settings > Auth health card, `chat:auth:test`, then see "rotating the token" |
| New sign-ins fail, existing sessions work | Service credential rejected (token rotated in the portal): save the new token |
| A person cannot sign in after being removed and re-created upstream | The old identity is deactivated: `chat:auth:reactivate`, or the same email links again once the old identity is gone |
| Dead-letter file grows | Look at `reason` and `type`; unknown event types are acked, not dead-lettered |
| Widget shows no bubble / "bundle not built" | `npm run build:widget` was not run in the image |
| Visitors wait past the queue timeout, queued chats never turn `missed`, active chats never close as idle, ended chats stay `ended` | The scheduler is not running (`schedule:run` every minute, or `schedule:work`): `chat:expire-queued`, `chat:offer-waves`, `chat:close-idle` and `chat:close-unrated` are scheduled every minute; run one by hand to confirm (`php artisan chat:expire-queued`). The delayed `ExpireQueuedConversation` / `OfferNextWave` jobs need the queue worker; without it (or with `QUEUE_CONNECTION=sync`, which runs a delayed job at once, too early) the second routing wave (away agents) is made by the `chat:offer-waves` sweep instead, up to a minute late, and expiry waits for `chat:expire-queued`. Run a real queue worker (database or Redis) for the exact timing |
| `409 no_agents` although agents are signed in | Presence needs a heartbeat younger than 90 s (the dashboard beats every 30 s): check `GET /me/presence`; the agent must serve the category (Settings of the agent), be under `max_concurrent_chats`, and the widget must be inside its opening hours. Away agents only count from the second routing wave on if the widget's `routing.waves` includes them |
| Away agents are offered a chat much later than the configured wave delay (20 s by default) | No queue worker, or `QUEUE_CONNECTION=sync`: the wave comes from the per-minute `chat:offer-waves` sweep. Start `php artisan queue:work`; `php artisan chat:offer-waves` makes due waves by hand (output: how many chats advanced) |
| Replies to offline tickets are not delivered | `OfflineTicketReply` is a queued mail: needs the queue worker and working SMTP settings; failed ones are in `failed_jobs` (the reply itself is stored in the conversation) |
| Image uploads fail with 422 `file` | Over `chat.attachment_max_bytes` / `chat.attachment_max_dimension`, not a real jpeg / png / webp / gif, an animated GIF (refused: send a still), too many pixels for PHP's `memory_limit` (a 4096 x 4096 image needs about 150 MB while it is processed), or `attachment_quota_exceeded`: the conversation holds `chat.attachment_max_total_bytes` (30 MiB) of images already |
| Visitors get `429 rate_limited` when starting chats | The chat-start guards: 3 starts a minute per widget and client network (`chat.rate_limits.start_per_widget_network`), a 10 s cooldown after cancelling a queued chat, at most 3 chats waiting per network (`chat.max_queued_per_network`); behind a proxy make sure `TRUSTED_PROXIES` is set, otherwise every visitor shares the proxy's address. A large office NAT needs the limits raised in `config/chat.php` |
| Chat attachments pile up on disk | `chat:prune-visitor-sessions` (daily) deletes uploads no message referenced for 24 h; sent attachments live with their conversation |
| The chat panel never opens | Check that `public/build` contains the embed entry (`npm run build`) and that the page's origin is on the widget's domain list; the loader's handshake times out when the iframe never answers (blocked by CSP `frame-ancestors`, or the host page is not on the list) |

- [ ] TBD (P5/P8): realtime (Reverb), presence sweep and push symptoms

## Load-test results

TBD in P7 (k6, about 1k concurrent sockets): record date, hardware, p50/p95 latency, connection count, and fd/CPU/RAM limits. See [realtime.md](realtime.md).
