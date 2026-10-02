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

## WhatsApp (OpenWA) operations

Background: [whatsapp-openwa.md](whatsapp-openwa.md) (the verified guide to the gateway: image, SSRF allow-list, ban risk), [rest-api.md](rest-api.md) ("WhatsApp API (P6)"), [security.md](security.md).

**Processes.** A queue worker is required (webhook deliveries are processed by `ProcessWebhookDelivery`, replies are sent by `SendWhatsAppMessage`, a session starts in `RunWhatsAppSessionStart`, large images are fetched by `FetchInboundMedia`: with `QUEUE_CONNECTION=sync` they run inside the request, which also means a reply waits for its pacing slot inside the HTTP request: development only). The scheduler (`schedule:run` every minute) runs `whatsapp:reconcile-sessions` (every minute), `whatsapp:replay-deliveries` (every 5 minutes) and `whatsapp:prune` (daily 04:15). **`retry_after` of the queue connection must be longer than the longest job timeout** (`config/queue.php`: 300 s by default for the `database` and `redis` connections, `DB_QUEUE_RETRY_AFTER` / `REDIS_QUEUE_RETRY_AFTER`; the longest job, `RunWhatsAppSessionStart`, times out after 150 s): below it a job that is still running is started a second time, and a WhatsApp reply would be sent twice. Keep every `queue:work --timeout` below it as well. Reverb is optional (the inbox falls back to REST).

**First setup.** (1) OpenWA running and reachable from the app (`curl http://<openwa>:2785/api/health`); an unscoped `operator` key. (2) Settings > WhatsApp: address, key, **Test connection** (`ok`, `role`, `canOperate`). A loopback / private address needs `PORTAL_ALLOW_PRIVATE_HOSTS=true` on the app. (3) The application URL (the `app.url` setting) must be an address **OpenWA can call back**, the final one (https, no redirect in front of it): `/webhooks/openwa/<session ulid>` is registered at OpenWA from it. OpenWA refuses private addresses unless its `SSRF_ALLOWED_HOSTS` lists the exact host (no wildcards, ports or CIDR); `host.docker.internal` for development, never `127.0.0.1`. (4) Add a session (3-50 letters, digits, hyphens), Start, scan the QR with the **dedicated** phone, wait for `ready`. (5) Link the session to a widget, switch `whatsapp.enabled` on and publish the widget's `features.whatsapp`.

**Re-pairing** (the phone unlinked it, was offline for weeks, WhatsApp logged it out): the session shows `disconnected` with a reason. Press **Start** again: no scan is needed when OpenWA still holds the login, else the status becomes `qr` and the QR appears (it refreshes about every 60 s; Stop then Start gives a fresh engine). The webhook and its secret stay (they are registered once per session; a session OpenWA lost is created again and gets a fresh webhook on Start).

**Sync** (Settings > WhatsApp > Sync, or wait a minute for the scheduled run) writes what OpenWA reports; a session OpenWA no longer knows becomes `failed` and Start creates it again.

| Symptom | Likely cause / check |
|---|---|
| Start answers `422 webhook_rejected` | OpenWA refused the callback address (`Destination address is not allowed`, or a bare 400 in production). The message names the address and the host to allow: add the exact host of the application URL to OpenWA's `SSRF_ALLOWED_HOSTS` and recreate the container, or use a public https address / a tunnel. In development with OpenWA in Docker set the application URL to `http://host.docker.internal:<port>`. `127.0.0.1` can never work |
| Start answers `409 webhook_limit_reached` | OpenWA already holds its 16 webhooks for the session (an earlier registration was lost): delete them in OpenWA (`GET/DELETE /api/sessions/{id}/webhooks`) or the session there, then Start |
| Session registered, no message ever arrives | OpenWA cannot reach the callback: `GET /api/webhooks/delivery-failures` at OpenWA (`lastError`, `lastStatusCode`), `POST /api/sessions/{id}/webhooks/{wid}/test`, `curl -X POST <callback>` from inside the OpenWA container. A `302` is a failed delivery (OpenWA never follows redirects): the registered address must be the final https one. Behind Caddy set `TRUSTED_PROXIES`. The reconciliation keeps statuses right, but messages only arrive by webhook |
| OpenWA retries every delivery 3 times and the app answers `401` | The signature does not verify: a proxy changed the raw body, or the app's secret is not the registered one (the application key changed, a database was restored, someone edited the webhook at OpenWA). **Re-register the webhook**: `POST /whatsapp/sessions/{ulid}/webhook` removes the old webhook at OpenWA and registers a new one with a new secret (a Start does the same when the stored secret cannot be decrypted) |
| `429` from the webhook endpoint | The limiter `wa-webhook` (3000 a minute per session AND client network, a ceiling of 6000 per client network; `config/whatsapp.php` `webhook.rate_limits`): something other than OpenWA is hammering the URL, or OpenWA is behind a shared address with something noisy. A `429` loses events (OpenWA retries a few times), so raise the numbers rather than lower them |
| `400 invalid_webhook` from the webhook endpoint | The signed body has no usable `event` (a short name of letters, digits, dots, hyphens, underscores): not a delivery of a supported OpenWA. Nothing was stored; the unsigned `X-OpenWA-Event` header is never read |
| A message arrived at OpenWA but is not in the inbox | Its delivery may have been accepted and then lost or failed: `wa_webhook_deliveries` rows with `outcome` NULL (job lost) or `failed` keep their raw body, and `whatsapp:replay-deliveries` (every 5 minutes) queues them again, at most 5 times each (`config/whatsapp.php` `webhook.replay`); run it by hand to see what it did. A `failed` row whose budget is used up needs the cause fixed (its `error`) and `UPDATE wa_webhook_deliveries SET replays = 0 WHERE id = ...` |
| `413` from the webhook endpoint | The body is over 1 MiB (`whatsapp.webhook.max_body_bytes`): OpenWA's own cap is the same, check a proxy in between |
| QR never appears / stays old | The start job is still running (it blocks 6-25 s: the page shows `starting`); the `session.qr` webhook never arrived (the page then fetches it from OpenWA every 45 s: check the webhook line above); OpenWA's throttler (`429`: a tight loop somewhere); a QR lives about 60 s, Stop then Start |
| Session `disconnected` after an OpenWA restart | `AUTO_START_SESSIONS` is off in OpenWA (the default): press Start (no scan if the login is in OpenWA's volume) or set it |
| Session `failed` with "did not finish starting" | The engine could not come up in time (WhatsApp Web unreachable from the container, a stalled browser, too little memory (1.5 GiB), a bad proxy): OpenWA's logs, then Start again |
| Replies stay `pending` | The queue worker is not running; or the minimum interval (`whatsapp.send_min_interval_ms`, default 1.5 s) is holding the next send; or an OLDER reply of the same chat is still going out (replies of one chat are sent in the order they were written); or OpenWA is reconnecting (`409`, retried for up to 20 minutes); or the send MAY have gone out and is not confirmed (a timeout, a `502` / `504` from a proxy, an answer without a message id, our own database failing right after OpenWA said `201`: it is never sent again, stays `pending` until OpenWA's `message.sent` webhook, and the reconciliation fails it after 30 minutes with "may or may not have been delivered": look at the phone before sending it again) |
| `503 queue_unavailable` on a reply | The queue refused the job (Redis down): the reply is stored as `failed` (and shown so); once the queue is back, sending the same reply again (the dashboard's retry, same `client_msg_id`) queues it |
| Replies turn `failed` | The message row carries the reason (administrators only): the session was not connected, OpenWA has no engine (`400 not active`: the session is reconciled), OpenWA's own `SEND_PACING_LIMITED` (its warm-up / cold-reachout cap, can be hours), the key was refused, WhatsApp reported a failure (a number that is not on WhatsApp is `201` first, then a failure ack) |
| `409 reply_not_allowed` | `whatsapp.reply_only_to_inbound` is on and the customer never wrote first (a chat started by the phone's own message). This is the main ban protection: switch it off only knowingly |
| `429 daily_cap_reached` | The session sent `whatsapp.daily_send_cap` messages today (UTC). It starts over at 00:00 UTC; a session can override the cap (`PATCH /whatsapp/sessions/{ulid}`); a failed send gives its slot back |
| Customers show no phone number | The sender is an `@lid` privacy id and OpenWA's `RESOLVE_LID_TO_PHONE` is off (default): set it to `true` |
| An image is missing from a chat | Above ~768 KiB OpenWA does not inline it: the app fetches it (`FetchInboundMedia`, needs the worker; 404 at OpenWA = nothing stored); the file must pass the image sanitiser (a real still jpeg / png / webp / gif within `whatsapp.media_max_bytes`); documents, audio, video and stickers are recorded without a file by design |
| Everything WhatsApp-related answers `503 openwa_unavailable` | OpenWA is down or the address is wrong; `502 openwa_unauthorized`: the key was refused (revoked, wrong, or a viewer / scoped key: Test connection says which); `409 openwa_not_configured`: no key saved |
| A deleted session's name is refused | `409 session_name_teardown_pending`: OpenWA is still cleaning up, retry in a few seconds (the app already retries three times) |
| The disk fills with `whatsapp/media` | Check `whatsapp:prune` runs (daily); images are only deleted when no message points to them; set `WHATSAPP_MEDIA_DISK` to a bigger disk |

Commands: `php artisan whatsapp:reconcile-sessions` (what the minute run does, with a summary line), `php artisan whatsapp:replay-deliveries` (queues accepted deliveries again whose job was lost or that failed), `php artisan whatsapp:prune [--deliveries-days=30] [--tickets-days=1] [--media-hours=24]`.

**Retention and erasure.** Settings > WhatsApp (`PUT /whatsapp/settings`): `retention_days` (default 0 = keep for ever) makes the daily prune delete messages, their stored images and the emptied chats older than that many days; `raw_retention_days` (default 30; 0 = the raw webhook object is not stored at all) drops the raw object kept for debugging. One customer's chat is erased on request with `DELETE /whatsapp/chats/{ulid}` (messages and images included, audited without personal data). See [security.md](security.md).

**Known limits (P5/P6, accepted).** (1) A chat that is already linked to a widget and visitor is never re-linked: a customer who sends a second hand-off code from the same number keeps the first link (re-linking would let anyone who can read a code move a customer's chat; link by hand in the database if it is really needed). (2) The presence announcements are not ordered across processes: two heartbeats racing at a status change may announce `presence.changed` in either order; the next heartbeat or the minute sweep announces the true status, so a dashboard is wrong for at most a minute. (3) *(closed in P7)* a demoted or deactivated administrator's open sockets, WhatsApp channel included, are closed by the server ([realtime.md](realtime.md) "Cutting a socket off").

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
| Visitors wait past the queue timeout, queued chats never turn `missed`, active chats never close as idle, ended chats stay `ended` | The scheduler is not running (`schedule:run` every minute, or `schedule:work`): `chat:expire-queued`, `chat:offer-waves`, `chat:close-idle`, `chat:close-unrated`, `chat:presence-sweep` and `chat:realtime-sweep` are scheduled every minute; run one by hand to confirm (`php artisan chat:expire-queued`). The delayed `ExpireQueuedConversation` / `OfferNextWave` jobs need the queue worker; without it (or with `QUEUE_CONNECTION=sync`, which runs a delayed job at once, too early) the second routing wave (away agents) is made by the `chat:offer-waves` sweep instead, up to a minute late, and expiry waits for `chat:expire-queued`. Run a real queue worker (database or Redis) for the exact timing |
| `409 no_agents` although agents are signed in | Presence needs a heartbeat younger than 90 s (the dashboard beats every 30 s) and an agent who is not `offline` by choice (an agent who is `away` because their tab sat in the background, or who chose `Away`, is offered chats from the second wave on): check `GET /me/presence`, which says exactly what routing sees; the agent must serve the category (Settings of the agent), be under `max_concurrent_chats`, and the widget must be inside its opening hours. Away agents only count from the second routing wave on if the widget's `routing.waves` includes them |
| Away agents are offered a chat much later than the configured wave delay (20 s by default) | No queue worker, or `QUEUE_CONNECTION=sync`: the wave comes from the per-minute `chat:offer-waves` sweep. Start `php artisan queue:work`; `php artisan chat:offer-waves` makes due waves by hand (output: how many chats advanced) |
| Replies to offline tickets are not delivered | `OfflineTicketReply` is a queued mail: needs the queue worker and working SMTP settings; failed ones are in `failed_jobs` (the reply itself is stored in the conversation) |
| A demoted / deactivated member or a visitor with a dead token still receives live events | The stale-socket cut-off could not close the socket: Reverb unreachable from the application (`REVERB_PUBLISH_*`, the signed `terminate_connections` call fails like a publish; look for `BroadcastException` in the log), the scheduler is not running (`php artisan chat:realtime-sweep` retries parked calls, repeats every cut after 20 s and closes expired visitor tokens: its output says what it did), or the client library drops `channel_data` for private channels (the subscription would be refused, so this one cannot happen silently). `socket_cutoffs` lists what is still parked; a hard cut-off is `php artisan reverb:restart` ([realtime.md](realtime.md) "Cutting a socket off") |
| Image uploads fail with 422 `file` | Over `chat.attachment_max_bytes` / `chat.attachment_max_dimension`, not a real jpeg / png / webp / gif, an animated GIF (refused: send a still), too many pixels for PHP's `memory_limit` (the pipeline needs about 11 to 13 bytes per pixel at its peak, so a 4096 x 4096 image needs about 220 MB while it is processed; the check refuses with 14 bytes per pixel rather than letting PHP die), or `attachment_quota_exceeded`: the conversation holds `chat.attachment_max_total_bytes` (30 MiB) of images already |
| Visitors get `429 rate_limited` when starting chats | The chat-start guards: 3 starts a minute per widget and client network (`chat.rate_limits.start_per_widget_network`), a 10 s cooldown after cancelling a queued chat, at most 3 chats waiting per network (`chat.max_queued_per_network`); behind a proxy make sure `TRUSTED_PROXIES` is set, otherwise every visitor shares the proxy's address. A large office NAT needs the limits raised in `config/chat.php` |
| Chat attachments pile up on disk | `chat:prune-visitor-sessions` (daily) deletes uploads no message referenced for 24 h; sent attachments live with their conversation |
| The chat panel never opens | Check that `public/build` contains the embed entry (`npm run build`) and that the page's origin is on the widget's domain list; the loader's handshake times out when the iframe never answers (blocked by CSP `frame-ancestors`, or the host page is not on the list) |

### Presence (P5)

Needs: the scheduler (`chat:presence-sweep`, every minute, `withoutOverlapping` + `onOneServer`, which need a shared cache), and for the default Redis store the **phpredis** extension (`REDIS_CLIENT=phpredis`) and a Redis that does not evict keys under memory pressure for these few small keys (`maxmemory-policy` `noeviction` or `volatile-*`, not `allkeys-*`: an evicted record reads as an agent who went offline). The store is chosen by `PRESENCE_STORE` (`redis` | `database`; default `redis` when `CACHE_STORE`, `QUEUE_CONNECTION` or `SESSION_DRIVER` is `redis`); `PRESENCE_REDIS_CONNECTION` / `PRESENCE_REDIS_PREFIX`, `PRESENCE_HEARTBEAT_WINDOW` (seconds, default 90: keep it above 60) and `PRESENCE_AUTO_AWAY_MINUTES` (default 5, 0 = off) tune it. Keys: `presence:{userId}` (hash, expires 180 s after the last heartbeat) and `presence:alive` (sorted set), under Laravel's own Redis prefix. The details and the failure mode are in [realtime.md](realtime.md) "Presence".

| Symptom | Likely cause / check |
|---|---|
| Agents with the dashboard open read `offline` | The dashboard now learns it from the answer of its own heartbeat (`POST /me/presence/heartbeat` answers the effective status); `GET /me/presence` says what the server thinks. The dashboard must be beating (`POST /me/presence/heartbeat` every 30 s, `200`); an agent who chose `Offline`, or whose Redis record expired (silent for 3 minutes: a sleeping laptop; Redis restarted or flushed) has to pick `Online` again, the inbox shows a one-click "Go online". Check Redis is up (`redis-cli ping`) and that `PRESENCE_REDIS_CONNECTION` points at it |
| `Presence: Redis is unavailable, the database store answers instead.` in the log | Redis cannot be reached: nothing fails (the database store answers for `presence.failure_cooldown_seconds` = 15 s at a time, one warning per switch), but fix Redis. Agents come back with their next heartbeat; after the outage whoever Redis lost reads `offline` until they choose a status |
| Agents stay `online` / `away` long after closing the dashboard | The sweep is not running (check the scheduler and `php artisan chat:presence-sweep` by hand: it prints how many agents it changed). Reads already treat a silent agent as `offline` after 90 s; only the `presence.changed` event, the roster and the cache of the public availability wait for the sweep (up to a minute) |
| Agents never turn `away` by themselves | Only an agent who chose `Online` in the dashboard (the automatic status, `isManual: false`) follows the tab; one who pinned `online` through the API does not. `PRESENCE_AUTO_AWAY_MINUTES=0` turns it off. A visible tab of the same agent (any device) keeps them `online` |
| A widget shows offline while agents are `away` | A widget whose `routing.waves` only offer chats to `online` agents does not count `away` ones; the cached answer is dropped when an agent changes status |

## Query review (P7)

Method: `php scripts/perf/seed-dataset.php` builds 50 000 conversations / 498 000 messages / 30 000 visitors / 5 000 WhatsApp chats with 50 000 messages (bulk INSERTs, 38 s) in a dedicated `chatfeature_p7_*` / `chatfeature_perf*` database; `php scripts/perf/explain-hot-queries.php --out=report.md` runs the hot paths through the application's own HTTP kernel and console commands, captures every SQL statement and runs `EXPLAIN` and `EXPLAIN ANALYZE` on it (writes are rolled back). MySQL 9.6 on an Apple M4 laptop. Hot paths covered: staff queue, dashboard hydrate (agent and admin), history filters, history search, export, opening a conversation (`after_seq`), sending, claim, the visitor panel (conversation, messages, availability, session), starting a chat (offers), the `queue.updated` job, every scheduled sweep, the WhatsApp inbox and search.

| Path | Before | After | Change |
|---|---|---|---|
| History search, 6 searches (admin and agent, rare / common / ticket / e-mail / no match) | 35.0 s (8 to 22 s each) | 0.9 s (10 to 570 ms each) | **query rewrite**: the OR of three correlated `EXISTS` (visitor lookup and a FULLTEXT probe per conversation row, 50 000 times) became uncorrelated `IN (subquery)`, materialised once. Same semantics; MySQL measured 12 s to 42 ms for a rare word |
| WhatsApp inbox search | 18.7 s | 0.10 s | the same rewrite in `WaChatSearch` |
| Queue listing, hydrate, history filters, opening a conversation, sending, claiming, visitor panel | 9 to 490 ms per scenario | 4 to 250 ms | no change needed (all index-served; the differences are cache warm-up) |
| `queue.updated` job (one visibleTo count per staff member, 40 staff) | 136 ms | 150 ms | unchanged: 3.7 ms per count, linear in the staff |
| Daily visitor prune (`delete from visitors where verified = 0 and created_at < ? and not exists ...`) | 8.4 ms (full scan of 30 000 rows) | 0.1 ms | new index `visitors (verified, created_at)` |
| Daily session prune (`expires_at < ? or revoked_at < ?`) | 6.5 ms (full scan) | < 0.1 ms | new index `visitor_sessions (revoked_at)` (index merge) |
| Retention candidates "nothing to delete yet" (`status in (closed, missed) and closed_at < ?`) | 16.4 ms (full scan) | 0.1 ms | new index `conversations (status, closed_at)` |

Migration `2026_12_10_000300_add_query_review_indexes.php`. Not added, on evidence: an agent-and-status history index (the plan is an early-terminating reverse primary-key scan, 1 to 2 ms), anything for the message list (`unique (conversation_id, seq)` serves `after_seq`), the offers (`unique (conversation_id, user_id)`, `(user_id, responded_at)`).

Left as it is, with the reason:
- **WhatsApp inbox order** `ORDER BY COALESCE(last_message_at, created_at) DESC` cannot use `wa_chats (status, last_message_at)`: a filesort of the open chats (25 ms at 5 000 chats, linear). Fix when a number reaches the 50 000s: make `last_message_at` NOT NULL (backfill with `created_at`) and order by it.
- **A scheduler catch-up** (the scheduler was down for hours) closes idle / unrated conversations one by one: about 8 statements per conversation (the widget, category and user of each are loaded per row; 38 000 statements and 9 s for 5 000 conversations, rolled back). Steady state is a handful a minute. If it ever matters, preload the three relations per batch.
- **Retention throughput**: `chat:prune-conversations` deletes about 58 conversations a second on MySQL with a FULLTEXT index on `messages.body` (4 271 conversations / 43 115 messages in 73 s; one delete per conversation so a stuck file never loses rows). The scheduled run has a 50-minute budget (about 170 000 conversations a night); a bigger backlog continues the next night.
- N+1 guards: `tests/Feature/Performance/QueryCountGuardTest.php` pins that the staff list, queue, history search, export, both message lists, the visitor conversation, the WhatsApp inbox (and its search) and the transfer targets issue the same number of statements for 2 and for 16 rows.

## Load-test results

Script: `scripts/loadtest-realtime.mjs` (Node, `pusher-js` from the repository, no new dependency). It provisions throwaway widgets / agents in a `chatfeature_p7_*` / `perf*` database, then through the REAL APIs: starts a session per visitor (`POST /public/widgets/{key}/sessions`), starts a chat (offered to all 20 online agents; one agent accepts it through `POST /conversations/{ulid}/claim`), authorises and opens one websocket per visitor on `private-conversation.{ulid}`, then runs the message storm: every visitor posts a message every `--interval` seconds (jittered), an agent answers half of them. Latency = from the moment a message's POST is sent to the moment `message.created` reaches the visitor's own socket. It samples CPU, memory and open file descriptors of the Reverb process (or container), the PHP workers and MySQL, counts disconnects and lost events, and writes JSON (`--out`).

**Environment (2026-10-02).** Apple M4 (10 cores), 16 GB, macOS 26.6; MySQL 9.6 (Homebrew, same machine); Node 24.14.1 (the client, same machine); Reverb 1.12 in a Docker Desktop container (Docker Desktop VM with 10 CPUs and 7.7 GiB, image `php:8.4-cli` + `pdo_mysql pcntl sockets uv`, `--ulimit nofile=65536:65536`); the application as the PHP built-in server (`php -S`, 16 workers: NOT php-fpm, one request per worker) with `QUEUE_CONNECTION=sync` (the queued broadcasts run inside the request), `CACHE_STORE=file` (so the rate limiters and the file cache are on disk), `PRESENCE_STORE=database`, `TRUSTED_PROXIES=*` and an `X-Forwarded-For` per simulated visitor (each has its own network for the limiters); 10 widgets (the start-a-chat budget is per widget). Other agents' browser and e2e processes ran on the same machine, so every number is conservative and noisy. A production deployment (php-fpm, a queue worker, Redis cache, a separate host for Reverb) has more headroom than this laptop.

```bash
# Reverb (Linux, ext-uv): an image built FROM php:8.4-cli with `install-php-extensions pdo_mysql pcntl sockets uv`; the app is mounted, so the
# database name comes from its .env, the other variables mirror PHP_ENV in the script, DB_HOST points at the host's MySQL
docker run -d --name pne-chat-p7c-reverb --ulimit nofile=65536:65536 -p 8316:8316 -v "$PWD":/app -w /app \
  -e APP_ENV=local -e APP_INSTALLED=true -e APP_URL=http://127.0.0.1:8312 -e BROADCAST_CONNECTION=reverb -e CACHE_STORE=file -e SESSION_DRIVER=file \
  -e QUEUE_CONNECTION=sync -e DB_HOST=host.docker.internal -e REVERB_APP_ID=1003 -e REVERB_APP_KEY=loadtest-key -e REVERB_APP_SECRET=loadtest-secret \
  -e REVERB_HOST=127.0.0.1 -e REVERB_PORT=8316 -e REVERB_SCHEME=http -e REVERB_SERVER_HOST=0.0.0.0 -e REVERB_SERVER_PORT=8316 \
  -e REVERB_ALLOWED_ORIGINS=127.0.0.1,localhost pne-chat-p7c-reverb:uv php artisan reverb:start --host=0.0.0.0 --port=8316
# the test (a fresh database; the shell needs `ulimit -n 65536`, macOS defaults to 256)
(ulimit -n 65536; node scripts/loadtest-realtime.mjs --spawn-web --reverb-container=pne-chat-p7c-reverb \
   --visitors=1000 --agents=20 --duration=90 --interval=60 --ramp-per-second=12 --web-workers=16 --out=light.json)
```

| | 1 020 sockets, light storm (`--interval=60`, about 17 messages/s) | 1 020 sockets, heavy storm (`--interval=15`, about 52 messages/s attempted) |
|---|---|---|
| Visitor sockets connected / failed | **1 000 / 0** (plus 20 agents) | 1 000 / 0 |
| Unexpected disconnects | **0** | 0 |
| Websocket connect time (p50 / p95 / p99) | 1.2 / 2.5 / 3.5 ms | 1.4 / 2.7 / 3.6 ms |
| Subscribe time = auth call + subscription (p50 / p95 / p99) | 320 / 950 / 1 310 ms (the auth POST is the cost) | 515 / 1 640 / 2 560 ms |
| Visitor message, POST to `message.created` on the visitor's socket (p50 / p95 / p99) | **170 / 1 090 / 1 510 ms** | 2 780 / 8 140 / 10 040 ms |
| Agent reply, POST to `message.created` at the visitor (p50 / p95 / p99) | **23 / 293 / 966 ms** | 2 140 / 7 200 / 8 600 ms |
| Events lost / late (> 5 s) | **0 / 0** | 1 149 sends failed (connection resets of the PHP dev server) / 803 late |
| HTTP `POST sessions` / `start chat` / `claim` p50 | 550 / 216 / 93 ms | 848 / 880 / 271 ms |
| Reverb peak CPU / RSS / open file descriptors | 18 % of one core / 110 MB / 1 035 | 23 % / 110 MB / 1 034 |
| PHP workers peak CPU (sum) / MySQL peak CPU | 296 % / 74 % | 457 % / 154 % |
| Events fanned out (chat.offered / chat.taken / queue.updated at the 20 agents) | 20 000 / 19 000 / 48 400 | 20 000 / 19 000 / 48 500 |

**Reading it.** (1) **1 000 concurrent visitor sockets work.** Reverb itself is nowhere near its limit: 18 to 23 % of one core and 110 MB for 1 020 connections and 50 000 broadcast frames; the realtime hop (publish to socket) is a few milliseconds, which is why an agent's reply (one HTTP call, the event published inside it) reaches the visitor in 23 ms at the median. (2) **The application tier is what saturates**: at about 17 messages a second a visitor's message needs 170 ms at the median (the visitor routes run two rate limiters on the file cache and several queries); at about 52 a second the 16 single-request PHP workers, MySQL and the sync queue (every broadcast is published inside the request) drown, latency grows to seconds and the dev server resets connections. That is the capacity of THIS setup (about 40 sends a second), not of Reverb: a real deployment runs php-fpm with more workers, a queue worker for the non-immediate broadcasts, Redis for the limiters and its own host. (3) A chat start fans out to every online agent (20 offers, 19 `chat.taken`, up to 48 `queue.updated` frames per chat): that is the price of first-accept-wins; the `queue.updated` job is one count query per staff member (3.7 ms each at 50 000 conversations).

**The hard ceiling without `ext-uv` (found by the same test).** On the host PHP (no `ext-uv` / `ext-ev` / `ext-event`) ReactPHP falls back to `stream_select()`, whose `FD_SETSIZE` is 1024. The first attempt (host Reverb, 1 000 visitors) reached 990 visitors, the last ones answered `unavailable`, the process showed 1 020 open file descriptors and then **Reverb exited with status 0 and no message** (reproduced with bare websockets and no chat traffic: about 1 013 connect and every one is dropped when it exits). The container with `ext-uv` held more than 2 500 bare websockets and, in the runs above, 1 020 working chat sockets. Consequences: the Docker image MUST install `ext-uv` (`install-php-extensions uv`) for the Reverb service; raise `nofile` (compose `ulimits: nofile: {soft: 65536, hard: 65536}`); and as a guard on an image without it set `REVERB_APP_MAX_CONNECTIONS=900` (Reverb then refuses connection 901 gracefully instead of dying); a restart policy of `on-failure` would NOT restart a process that exits 0, use `unless-stopped` / `always`. Also check `docker compose logs reverb` for a clean exit when everybody loses realtime at once.

**Not measured:** several Reverb instances behind Redis scaling (`REVERB_SCALING_ENABLED`), TLS termination at Caddy, browsers (the clients are `pusher-js` in Node), a queue worker instead of `QUEUE_CONNECTION=sync`, Redis for cache / presence. Run the same script against the real stack in P8 (`--web=https://... --reverb-host=... --reverb-port=443` need a TLS-capable variant of the client, not built).

