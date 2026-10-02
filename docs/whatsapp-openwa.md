# WhatsApp via OpenWA: the operations guide

> Status: verified on 2026-10-02 against the real image (see "Versions"). Everything marked **recorded** was captured from a running OpenWA by `scripts/openwa-record.mjs` (fixtures in `tests/fixtures/openwa`, catalogue below); everything marked **documented** comes from [reference/openwa-api.md](reference/openwa-api.md) and could not be reproduced without a paired phone (inbound message payloads, acks, `SEND_PACING_LIMITED`, `SESSION_NAME_TEARDOWN_PENDING`). Decisions: [contracts/whatsapp-p6.md](contracts/whatsapp-p6.md). Data layer: [contracts/whatsapp-data-p6.md](contracts/whatsapp-data-p6.md). The app's own routes: [rest-api.md](rest-api.md) ("WhatsApp API (P6)").

[OpenWA](https://www.open-wa.org) (repo `rmyndharis/OpenWA`, MIT) is a self-hosted WhatsApp gateway: one container with a REST API, a dashboard, and one headless Chromium per connected number (engine `whatsapp-web.js`, the default) or a lighter socket engine (`baileys`). It is **not** the old wa-automate project. PNE Chat talks to it over HTTP (`POST /api/sessions`, `send-text`, ...) and receives messages through signed webhooks. WhatsApp is **hand-off + record, admin-only**: a visitor on the site gets a code, sends it from their phone, the chat is linked to the visitor and the widget, administrators read and reply in the WhatsApp inbox; agents never see it.

## Versions

| What | Value |
|---|---|
| Image | `ghcr.io/rmyndharis/openwa` **0.23.7** (OCI label `org.opencontainers.image.version`, revision `3a47b43038ad7a2e388fa161d1ff2622df43065e`, built 2026-09-25) |
| Pinned digest (multi-arch index that `:0.23.7` and `:latest` pointed to) | `sha256:9a9eeee07de00902ca41b30c67cc4a3bb2b219df5c5e54357994f66a1808ee12` (linux/amd64 `cab22773...`, linux/arm64 `1aad6009...`). Tested on arm64 (Apple silicon); the production KVM pulls the amd64 manifest of the same index |
| Engine | `whatsapp-web.js` (`ENGINE_TYPE`), WhatsApp Web build `2.3000.1048960956-alpha` pinned by OpenWA at start (see "Security notes") |
| Runtime | Node 22; the process runs as the unprivileged user `openwa`, `HOME=/app/data` |
| Port | **2785**: REST under `/api`, the dashboard at `/`. The Swagger UI the start log advertises (`/api/docs`) answers 404 (docs are off by default) |
| Built-in `HEALTHCHECK` | `curl -f http://localhost:2785/api/health/ready` every 30 s (start period 30 s) |

Upgrade rule: change the digest on purpose, run `node scripts/openwa-smoke.mjs`, re-run `node scripts/openwa-record.mjs --out=<scratch dir>` and diff it against `tests/fixtures/openwa` before you roll it out.

## Quick start (development)

```bash
docker compose -f docker/compose.dev.yml --profile whatsapp up -d openwa   # image pinned by digest, published on 127.0.0.1:2785 only
docker exec pne-chat-dev-openwa-1 cat /app/data/.api-key                    # the admin API key (also printed once in the first start log)
node scripts/openwa-smoke.mjs --receiver-port=8368                          # connectivity, role, session, QR, signed webhook: all PASS
open http://127.0.0.1:2785                                                  # OpenWA's own dashboard (asks for the key)
```

Stop it with `docker compose -f docker/compose.dev.yml --profile whatsapp down`. The named volume `pne-chat-dev_openwa-data` stays: it holds the WhatsApp login and the keys. `down -v` deletes it, and the next start mints a new key and needs a new QR scan.

### The dev profile, line by line (`docker/compose.dev.yml`)

| Setting | Why |
|---|---|
| `image: ...@sha256:9a9e...` (`OPENWA_IMAGE` overrides) | The tested image. `:latest` moves. |
| `ports: 127.0.0.1:2785:2785` | The admin API key must not be reachable from the LAN. A plain `2785:2785` publishes on every interface. |
| `SSRF_ALLOWED_HOSTS: host.docker.internal` | Lets OpenWA deliver webhooks to the app running on your Mac / PC (see "Webhooks and the SSRF guard"). |
| `RESOLVE_LID_TO_PHONE: 'true'` | Senders identified by a privacy id (`...@lid`) get a `senderPhone` in `message.received`; without it such a customer has no phone number. |
| `AUTO_START_SESSIONS: 'true'` | The default is **off**: after a container restart a paired session stays `disconnected` until someone presses Start. |
| `CSP_UPGRADE_INSECURE_REQUESTS: 'false'` | The image sends `upgrade-insecure-requests`; over plain `http://localhost:2785` the dashboard's scripts are upgraded to https and the page renders blank. |
| `WEBHOOK_SHUTDOWN_DRAIN_MS: '10000'` | The image warns that its 5 s drain is shorter than the 10 s delivery timeout. |
| `volumes: openwa-data:/app/data` | `sessions/` (the login), `main.sqlite` and `openwa.sqlite`, `media/`, `plugins/`, `.api-key`, `.env.generated`. About 27 MB when empty. |
| `healthcheck` | The image's own check with a shorter interval, so `docker compose up --wait` returns in seconds. |

## Production fragment (for P8, `docker/compose.prod.yml`)

OpenWA never gets a published port: only the app and the queue worker reach it, over an internal network. Everything below was run against the image except where marked.

```yaml
services:
  openwa:
    image: ghcr.io/rmyndharis/openwa@sha256:9a9eeee07de00902ca41b30c67cc4a3bb2b219df5c5e54357994f66a1808ee12
    restart: unless-stopped
    networks: [backend, egress]               # backend: shared with `app` and `queue`; egress: a normal network for WhatsApp. NO `ports:`
    environment:
      ENGINE_TYPE: whatsapp-web.js
      RESOLVE_LID_TO_PHONE: 'true'
      AUTO_START_SESSIONS: 'true'              # a paired session comes back after a restart or a deploy
      API_KEY_PEPPER: ${OPENWA_API_KEY_PEPPER} # HMAC for stored key hashes: set BEFORE minting keys (the image warns otherwise)
      WEBHOOK_SHUTDOWN_DRAIN_MS: '10000'
      # SSRF_ALLOWED_HOSTS: app                # ONLY if the address the app registers is a private name (see below)
      # WWEBJS_WEB_VERSION: 'off'              # optional, see "Security notes"
    volumes:
      - openwa-data:/app/data                  # the WhatsApp login: back it up (below)
    mem_limit: 1536m                           # one session: 550-800 MiB measured; plus about 400 MB per extra session
    cpus: 1.0
    pids_limit: 512                            # one session runs about 150 processes (Chromium)
    security_opt: ['no-new-privileges:true']
    logging: { driver: json-file, options: { max-size: 10m, max-file: '3' } }
    # healthcheck: the image's own (curl /api/health/ready)
networks:
  backend: { internal: true }                  # app <-> openwa only
  egress: {}                                   # OpenWA must reach web.whatsapp.com
volumes:
  openwa-data:
```

- **Do not `cap_drop: [ALL]`.** The entrypoint starts as root and `chown`s `/app/data` before it drops to `openwa`; with every capability dropped the container exits at once (`chown: changing ownership of '/app/data': Operation not permitted`, verified). `no-new-privileges`, `--memory=1g`, `--cpus=1` and `--pids-limit=512` are fine: one session started in 21.6 s and served a QR at 721 MiB of 1 GiB (verified, no OOM kill). 1.5 GiB leaves room for Chromium spikes.
- **Memory.** An idle gateway uses 150-180 MiB; one running (`qr_ready`) session 545-800 MiB (node about 230 MB, Chromium browser about 210 MB, renderer about 280 MB). The earlier estimate of 300-500 MB per session is too low. Plan 1 GiB for the first number and about 400 MB for each further one.
- **Outbound access.** The engine downloads WhatsApp Web at start and keeps a WebSocket to WhatsApp: the container needs outbound HTTPS (`web.whatsapp.com`, `raw.githubusercontent.com` for the pinned build). An `internal: true` network alone starves it, hence the second network.
- **Backup.** The `openwa-data` volume is the WhatsApp login: lose it and you scan a QR again (and the admin key changes). Archive it with the container stopped (or from a snapshot): `docker run --rm -v openwa-data:/data -v "$PWD":/backup alpine tar czf /backup/openwa-data-$(date +%F).tgz -C /data .`. The message history lives in PNE Chat's database; OpenWA's own message store is a cache you can lose. The archive contains a live WhatsApp session: encrypt it before it leaves the machine.
- **API key handling.** The admin key is minted on the first start into `/app/data/.api-key` (mode 0600) and printed once in the log. Mint a second, **operator** key for the app (`POST /api/auth/api-keys {"name":"pne-chat","role":"operator"}`; the plaintext comes back once, in `apiKey`), save it in PNE Chat (Settings > WhatsApp, encrypted at rest) and keep the admin key out of the app. An operator key is enough for everything PNE Chat does (sessions, webhooks, send, media). Rotate by minting a new key, saving it in the app, revoking the old one. A key never goes into a URL: OpenWA accepts `X-API-Key` or `Authorization: Bearer` only.
- **After a restart** a paired session needs 6-25 s after the container is healthy before it is `ready`. The app's scheduled `whatsapp:reconcile-sessions` (every minute, per the 6A docs) writes whatever OpenWA reports.
- **The app side** needs a **queue worker** (starting a session, processing webhooks and sending replies are queued jobs) and the scheduler. Behind Caddy `TRUSTED_PROXIES` must be set ([runbook.md](runbook.md)). Put `PORTAL_ALLOW_PRIVATE_HOSTS=true` in the app's environment: `http://openwa:2785` is a private address and the base-URL rule accepts it only with that switch.
- **Do not publish OpenWA's dashboard** (`/`) through the reverse proxy: it is an admin console for a WhatsApp login. Reach it with `ssh -L 2785:openwa:2785` if you need it.

## Connecting the app

1. **Key and role.** The app needs an **unscoped `operator` or `admin` key**. Creating a session is a deployment-level act: a key scoped to some sessions gets `403 "Session-scoped API keys are not permitted on this route"`; a `viewer` key gets `403 "Insufficient permissions. Required: operator"` (both recorded). Settings > WhatsApp > "Test connection" reports `ok`, `role`, `engine` and `canOperate`; it calls `POST /api/auth/validate`.
2. **Settings** (Settings > WhatsApp, admin only; the key is encrypted): `whatsapp.openwa.base_url` (`http://127.0.0.1:2785` in development, `http://openwa:2785` in production), `whatsapp.openwa.api_key`, `whatsapp.enabled`. The base URL passes the app's SSRF guard: a loopback / private / Docker address is accepted only with `PORTAL_ALLOW_PRIVATE_HOSTS=true` (or `APP_ENV=local`).
3. **The address OpenWA delivers to.** The webhook the app registers is `<app.url>/webhooks/openwa/<session ulid>`, built from the `app.url` **setting** (the installer's application URL, never the request host). OpenWA must reach exactly that address:
   - production: the public https URL (`https://chat.example.com/...`). A hairpin through Caddy is fine; if the container cannot resolve or reach its own public name, add `extra_hosts` or list the name in `SSRF_ALLOWED_HOSTS`.
   - development with OpenWA in Docker and the app on your Mac: `php artisan tinker --execute "settings()->set('app.url', 'http://host.docker.internal:8323');"` (and keep `SSRF_ALLOWED_HOSTS=host.docker.internal`), or use a tunnel (a public https URL has no SSRF issue). `127.0.0.1` / `localhost` never work: inside the container it is the container itself, and OpenWA refuses loopback addresses anyway.
   - **No redirect in front of it.** A `302` answer is not followed and counts as a failed delivery. `app.url` must be the final scheme and host (`https`, not an `http` that Caddy redirects).
4. **Start a session** in Settings > WhatsApp: a name of 3-50 letters, digits and hyphens. The app creates it at OpenWA, registers **one** webhook with a random 40-character secret (OpenWA never shows a secret again: the app keeps its own encrypted copy), then asks OpenWA to start the engine. Re-creating a just-deleted name can answer `409 SESSION_NAME_TEARDOWN_PENDING` (documented, for a session that had been paired): retry in a few seconds.

## QR pairing with a real phone

Use a **dedicated number** (a spare SIM or eSIM with its own WhatsApp or WhatsApp Business account), never a personal one: see "Sending, pacing and ban risk".

1. Settings > WhatsApp > the session > **Start**. The engine takes 6-25 s; the status goes `starting`, then `qr`.
2. The page shows a QR (a 276x276 PNG that OpenWA refreshes about every 60 s while nobody scans it; the `session.qr` webhook and `GET .../qr` both serve the newest).
3. On the phone: WhatsApp > **Settings > Linked devices > Link a device**, then scan the QR on screen. (OpenWA can also pair with a number-entry code, `POST /api/sessions/{id}/pairing-code`; PNE Chat does not use it.)
4. Within seconds OpenWA sends `session.authenticated` (`phone`, `pushName`) and `session.status` `ready`; the page shows the masked number. The login is saved in the data volume (`/app/data/sessions/session-<id>`): a restart needs no new scan while `AUTO_START_SESSIONS=true`.
5. Keep the phone's WhatsApp alive. WhatsApp unlinks companion devices when the main phone has not been online for about two weeks, and anyone with the phone can unlink at any time (Linked devices). Either shows up as `session.disconnected` / status `disconnected` and needs a new scan.

## The real-device round trip: a checklist for you

Needs: a phone with the dedicated number, a second phone (or WhatsApp Web of another account) to play the customer, Docker Desktop, the app running (`composer dev` with a queue worker and `php artisan reverb:start`) and a page with the widget (the builder's live preview works).

| # | Do | Expect |
|---|---|---|
| 1 | `docker compose -f docker/compose.dev.yml --profile whatsapp up -d openwa`, then `node scripts/openwa-smoke.mjs --receiver-port=8368` | 9 lines PASS (gateway, role admin, session, QR, signed delivery, idempotency headers) |
| 2 | Set `app.url` to `http://host.docker.internal:<app port>` (tinker command above). Add `PORTAL_ALLOW_PRIVATE_HOSTS=true` to `.env` only if `APP_ENV` is not `local` | nothing visible yet |
| 3 | Settings > WhatsApp: base URL `http://127.0.0.1:2785`, API key = `docker exec pne-chat-dev-openwa-1 cat /app/data/.api-key`, enable, Save, **Test connection** | ok, role `admin`, engine `whatsapp-web.js`, `canOperate` true |
| 4 | Create the session `support-main`, **Start** | `starting`, then `qr` within about 30 s; a QR appears; wait a minute to see it refresh |
| 5 | Scan the QR with the dedicated phone (Linked devices) | status `ready`, the masked number, no QR any more |
| 6 | Widget builder > WhatsApp: pick the session, switch the channel on, publish | the widget's availability says WhatsApp is on |
| 7 | Open the widget on the page, choose WhatsApp (the chooser only appears when it is on) | an 8-character code (like `K7M2QX4P`) and a link `https://wa.me/<number>?text=Hi! My support code is <code>` |
| 8 | Open the link on the **customer** phone and send the prefilled message | within seconds a chat appears in the WhatsApp inbox, **linked** to the widget, visitor and topic, with the message and an unread badge |
| 9 | Reply from the inbox | `pending`, then `sent` (one tick), `delivered` (two), `read` (blue) as the customer's phone acknowledges; the customer reads the text |
| 10 | The customer sends an image, a voice note, and a text from a group | the image is stored and visible; the voice note is a typed row "attachment not stored"; the group message is ignored (default) |
| 11 | Sign in as an agent and open `/whatsapp` and `/settings/whatsapp` | 403 on both, no WhatsApp entry in the sidebar |
| 12 | `docker restart pne-chat-dev-openwa-1`, wait 40 s | the session is `ready` again by itself, without a scan |
| 13 | On the dedicated phone: Linked devices > the OpenWA device > Log out | the session turns `disconnected` within a minute; Start shows a new QR |

If a step fails, the troubleshooting table below is ordered by symptom. Do not skip step 1: it separates "OpenWA is wrong" from "the app is wrong".

## Webhooks and the SSRF guard

**Registration** (`POST /api/sessions/{id}/webhooks {url, events[], secret, retryCount?}`, recorded): `201` with the webhook (never the secret). `events` defaults to `["message.received"]` (the app registers `message.received`, `message.sent`, `message.ack`, `message.failed`, `session.status`, `session.qr`, `session.authenticated`, `session.disconnected`, `session.reconnect_loop`). `secret` must be at least 16 characters (`400` otherwise) and is write-only. At most **16 webhooks per session**: the 17th is `400 "Webhook limit reached for this session (16/16); delete one before registering another"` (`WEBHOOK_MAX_PER_SESSION`). A URL with `user:password@` is `400 "Webhook URL must not contain credentials (userinfo)"`; an unknown event `400`; an unknown session `404`. A webhook is deleted with its session.

**The SSRF guard** refuses, at registration and again at delivery, a URL whose host is private, loopback or link-local (`127/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10` (the CGNAT range Tailscale uses), `198.18/15`, multicast and reserved ranges, `::1`, `fc00::/7`, `fe80::/10`), `localhost`, and names that resolve to them (`host.docker.internal`, compose service names): `400 "Destination address is not allowed"` (recorded; the same answer for a non-http scheme). `SSRF_ALLOWED_HOSTS` is the escape hatch: a **comma-separated list of exact host names** (case-insensitive, no wildcards, no ports, no CIDR); a listed host is allowed even though it resolves to a private address. Allowing `host.docker.internal` does **not** allow `127.0.0.1`. `WEBHOOK_SSRF_PROTECT=false` switches the guard off entirely: do not.

**What the app must do with a delivery.** All recorded (fixtures `webhook-delivery-*`, `webhooks-delivery-failures`):

| Fact | Detail |
|---|---|
| Request | `POST`, `Content-Type: application/json` (no charset), `User-Agent: OpenWA-Webhook/1.0.0`, body `{event, timestamp (ISO), sessionId (the OpenWA session UUID), idempotencyKey, deliveryId, data}` |
| Headers | `X-OpenWA-Event`, `X-OpenWA-Idempotency-Key` (equals the body's `idempotencyKey`; **the application reads the signed body only, never these unsigned headers**), `X-OpenWA-Delivery-Id` (`dlv_<uuid>`, equals the body's `deliveryId`), `X-OpenWA-Retry-Count` (`0` for the first), `X-OpenWA-Signature` |
| Signature | `sha256=` plus the hex `HMAC-SHA256(secret, raw request body)`. **Verified**: every recorded delivery re-computes to its header (`openwa-mock.test.mjs` checks it). Compute over the raw bytes, compare in constant time, before parsing anything. |
| Idempotency key | Content-derived, **stable across retries**, always suffixed with `_{webhookId}`: `sess_<sessionId>_<status>_<occurredAt>_<webhookId>`, `qr_<sessionId>_<hash>_<webhookId>`, `msg_<sessionId>_<messageId>_<webhookId>`, `ack_<sessionId>_<messageId>_<status>_<webhookId>`. `X-OpenWA-Delivery-Id` is the same on automatic retries and **new on a replay**: never dedupe on it. Re-registering a webhook changes every key (a new webhook id), so keep the unique `(chat, message id)` index as the real guard. The `test` event's key is `evt_test_<12 hex>` (the reference says `test_<deliveryId>_<webhookId>`). |
| Retries | `retryCount` (default 3) is the **total** number of attempts. A non-2xx answer, a timeout (10 s, `WEBHOOK_TIMEOUT`) and a network error are failures; the delay doubles from 5 s (`WEBHOOK_RETRY_DELAY`): attempts at +0 s, +5 s, +15 s (recorded 0 / 5006 / 15012 ms). Same body, same ids, `X-OpenWA-Retry-Count` 0, 1, 2. After the last one the failure appears in `GET /api/webhooks/delivery-failures` (admin key) and the webhook stays active. |
| Redirects | **Never followed.** A `302` is a failed delivery (`lastError "Destination address is not allowed"`): answer `2xx` at the final URL. |
| Order | Not guaranteed across events (each delivery is independent): `message.ack` can arrive before the `message.sent` echo. Apply status changes forward-only. |
| Answer fast | `2xx` within 10 s. The app answers `200` at once and processes through the queue. |

**Events** (`data`):

| Event | `data` | Source |
|---|---|---|
| `session.status` | `{sessionId, status}`; status is one of `created, initializing, qr_ready, authenticating, ready, disconnected, action_required, failed` | recorded (`initializing`, `qr_ready`, `disconnected`); `ready` documented |
| `session.qr` | `{sessionId, qr: "data:image/png;base64,..."}`, the same image `GET .../qr` returns, a new one about every 60 s | recorded |
| `session.authenticated` | `{sessionId, phone, pushName}` | documented |
| `session.disconnected` | `{sessionId, reason}`: a drop or a phone-side unlink. **Not** sent for an API stop or delete: only `session.status` `disconnected` is | the stop case recorded, the shape documented |
| `session.reconnect_loop` | `{sessionId, attempts, nextDelayMs}` on every 5th reconnect attempt | documented |
| `message.received` | `{id, from, to, chatId, body, type, timestamp (epoch seconds), fromMe, isGroup, kind, author?, senderPhone?, isLidSender?, contact{name?, pushName?}, media?{mimetype, filename?, data? or omitted: true, sizeBytes?}}`; `kind` is `individual`, `group`, `channel`, `status`, `broadcast` or `unknown` | documented (`delivery-message-received-*`) |
| `message.sent` | the same shape for a message this session sent (an API reply echoes here with the id its `201` returned) | documented |
| `message.ack` / `message.failed` | `{id, messageId, status, ack}`: `status` is pending / sent / delivered / read / failed, `ack` the legacy integer (0-3, -1). **No chat id**: find the row by message id. `failed` sends both events. Whether `id` equals `messageId` is unverified: use `messageId`, fall back to `id`. | documented |

## Chat ids, kinds and media

- **Chat id dialects.** whatsapp-web.js reports a person as `<digits>@c.us`, Baileys as `<digits>@s.whatsapp.net` (message ids differ as well: `false_<chat>_<hash>` against the raw key id). A privacy id is `<digits>@lid` (`isLidSender: true`; `senderPhone` only with `RESOLVE_LID_TO_PHONE=true`). Groups are `...@g.us`, stories `status@broadcast`, channels `...@newsletter`. PNE Chat normalises both person dialects to `@c.us`, so an engine change does not split one customer into two chats.
- **`kind`** is the discriminator to trust: only `individual` is a customer chat. `group` is ignored by default (`whatsapp.ignore_groups`); `status` (stories), `channel` and `broadcast` are always ignored. `fromMe: true` is a message the phone itself sent, not a customer message.
- **Media.** The webhook inlines base64 media up to `WEBHOOK_MEDIA_INLINE_MAX_BYTES` (1 MiB) and caps the whole body at `WEBHOOK_MAX_PAYLOAD_BYTES` (1 MiB). Base64 inflates by a third, so media above about **768 KiB decoded** arrives as `{mimetype, filename?, omitted: true, sizeBytes}`. Fetch it with `GET /api/sessions/{id}/messages/{chatId}/{messageId}/media` (the chat id is part of the path: percent-encode the `@`). Answers: `200` with the raw bytes as an attachment (`Content-Disposition: attachment`, `nosniff`, an inert `Content-Type` only), or `404 "No media stored for this message"` (recorded) when nothing is stored (media above OpenWA's own cap `MEDIA_DOWNLOAD_MAX_BYTES`, 50 MiB, or `MEDIA_DOWNLOAD_ENABLED=false`, or a URL-based send). PNE Chat stores only images (after its image sanitiser, 5 MiB by default); documents, audio, video and stickers are typed rows without a file in P6.

## Sending, pacing and ban risk

- **Send** is `POST /api/sessions/{id}/messages/send-text {chatId, text}` (1-4096 characters; other fields are rejected). `201 {messageId, timestamp (epoch seconds)}` means **accepted, not delivered**: a message to a number that is not on WhatsApp is also `201`. Delivery shows up as `message.ack` webhooks. By default OpenWA types for `500 ms + 45 ms per character` (at most 5 s, `SIMULATE_TYPING`) before it sends, so the call can take **several seconds**: give the HTTP client at least 15 s. (Starting a session is the long call: 6-25 s, give it 90 s.)
- **Refusals.** Recorded unless noted: not started `400 "Session '<id>' is not active. Start the session first."`; the engine runs but WhatsApp is not connected (waiting for a scan, starting, reconnecting) `409 "Session is not connected. The WhatsApp client is not ready."` (retryable); a validation error `400`; `429 SEND_PACING_LIMITED` with `retryAfterSeconds` (documented; it can be hours: do not retry blindly); the plain throttler `429` (below).
- **OpenWA's global throttler** (recorded): 10 requests per second, 100 per minute and 1000 per hour **per client address**, shown on every response as `X-RateLimit-Limit-short|medium|long`. Over the limit: `429 {"statusCode":429,"message":"ThrottlerException: Too Many Requests"}` with `Retry-After: 1` and no `code`, no `error`. Polling the QR every 2-3 s is fine, a tight loop is not. `/api/health*` is exempt.
- **Pacing in PNE Chat** (the protections that matter, all on by default): replies only to chats the customer started (`whatsapp.reply_only_to_inbound`), at least 1.5 s between sends per session (`whatsapp.send_min_interval_ms`), 200 sends per session per UTC day (`whatsapp.daily_send_cap`). OpenWA's own pacing is off by default; `SEND_PACING_ENABLED=true` adds a warm-up daily cap that grows with the session's age, a cold-reachout cap and a failure breaker. For a brand-new number it is a sensible extra seat belt; expect `SEND_PACING_LIMITED` on a young session and let the app mark the message failed with the reason.
- **Ban risk.** Automating a WhatsApp account is against WhatsApp's terms and can get the number restricted or banned, with no appeal you control. Reduce it: a **dedicated number** (never the owner's personal one), a number that has been in normal use for a while, **reply only to customers who wrote first**, no bulk or promotional sends, a human pace, one pairing per number, the phone kept online. OpenWA reports restrictions WhatsApp places on a session (`restriction: {kind: reachout_timelock | tos_block | proxy_block, ...}` and the `session.restriction` event): treat `tos_block` as a stop sign. Engine choice: `whatsapp-web.js` (the default, the only one verified here) drives a real browser and is the conservative choice; `baileys` is lighter (no Chromium) and speaks the protocol directly, which is generally considered more detectable. PNE Chat handles both id dialects, but only `whatsapp-web.js` was verified.

## Security notes

- **The pinned WhatsApp Web build is fetched without an integrity check.** At every engine start the whatsapp-web.js engine downloads `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/<version>.html` and serves it into the `web.whatsapp.com` origin (the image logs `web_version_remote_pin ... WITHOUT an integrity check`). Whoever controls that file controls the page that holds the WhatsApp login. Options: `WWEBJS_WEB_VERSION=off` (use WhatsApp's own build; verified: the engine starts and serves a QR in the same time) or `WWEBJS_WEB_VERSION_REMOTE_PATH=<your own copy>`. The trade-off is compatibility: the pin exists because whatsapp-web.js can break when WhatsApp ships a new build, so run `off` for a while before you rely on it.
- **The data volume is a WhatsApp login:** treat backups like credentials.
- **Never expose** OpenWA's port or dashboard publicly; keep the key in the app's encrypted settings; use an operator key in the app, not the admin key.
- **API keys inside OpenWA** are stored as plain SHA-256 until `API_KEY_PEPPER` is set (the image warns at start): set the pepper before you mint the app's key, or re-issue keys afterwards.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Test connection says unreachable | Wrong base URL, container not running, port not published, or the app is in Docker and `127.0.0.1` is itself | `docker ps`; `curl http://127.0.0.1:2785/api/health`; from a container use the service name |
| `401 "Invalid API key"` or `"API key is required"` | Key mistyped, revoked, expired, or the data volume was recreated (new key) | `docker exec pne-chat-dev-openwa-1 cat /app/data/.api-key`, or mint a new key |
| `401 "API key not authorized for this session"` | A **scoped** key used on a session outside its `allowedSessions` (the reference says 403; it is **401**) | Use an unscoped key |
| `403 "Insufficient permissions. Required: operator"` | A viewer key | An operator or admin key |
| `403 "Session-scoped API keys are not permitted on this route"` | Creating a session with a scoped key | An unscoped key |
| Start takes 6-25 s, then `failed` or `504` | WhatsApp Web unreachable from the container (DNS, firewall, proxy), not enough memory (give 1.5 GiB), a bad `proxyUrl` | `docker logs`, `docker stats`; the start call blocks until the QR waits |
| Webhook refused: `Destination address is not allowed` | The registered address is private, loopback or a Docker name | `SSRF_ALLOWED_HOSTS=<exact host>` and recreate the container, or a public https address; check `app.url` |
| Registered, but nothing arrives | OpenWA cannot reach `app.url`; an http to https redirect; a firewall; Caddy or `TRUSTED_PROXIES` wrong | `GET /api/webhooks/delivery-failures` (`lastError`, `lastStatusCode`); `POST .../webhooks/{id}/test`; `curl -X POST <webhook url>` from inside the container |
| Deliveries arrive, the app answers 401, OpenWA retries 3 times | The signature does not verify: a middleware altered the raw body, or the app's secret is not the one registered | Verify over the raw bytes; stop and start the session in the app so it registers a fresh secret |
| Duplicate messages | At-least-once delivery, a replay, a re-registered webhook | Dedupe on the **body's** `idempotencyKey` (the headers are not signed: this application never reads `X-OpenWA-Idempotency-Key`, `-Event` or `-Delivery-Id`) and keep the unique `(chat, message id)` index |
| QR never appears or has expired | The start is still running; a QR lives about 60 s | Wait for `qr`; `GET .../qr` serves the newest; Stop then Start for a new engine |
| `disconnected` after a container restart | `AUTO_START_SESSIONS` is off (the default) | Set it, or press Start (no scan while the login is in the volume) |
| `disconnected` and a QR is needed again | The phone unlinked it, was offline for about two weeks, or WhatsApp logged it out | Scan again; check `restriction` |
| Replies stay `pending` or turn `failed` | Session not `ready`; `429`; `409 not connected`; the daily cap | The message row carries the reason (administrators only); `whatsapp.daily_send_cap` |
| A reply says sent but the customer got nothing | `201` is only acceptance; WhatsApp did not deliver (not a WhatsApp number, blocked, phone offline) | Watch the ticks; `GET .../contacts/check/<number>` says whether the number is on WhatsApp |
| A customer has no phone number | The sender is an `@lid` privacy id and `RESOLVE_LID_TO_PHONE` is off | Set it to `true` |
| An image is missing | Above about 768 KiB it arrives `omitted`; the media route answers 404 when nothing is stored | Check `MEDIA_DOWNLOAD_ENABLED`, the 50 MiB cap, the app's media cap |
| Everything answers `429` for a second | OpenWA's throttler (10 per second per client address) | Slow the loop; the app retries after a few seconds |
| The dashboard is blank over http | `upgrade-insecure-requests` | `CSP_UPGRADE_INSECURE_REQUESTS=false` (development) or serve it over https |
| The container exits at once with `chown: ... Operation not permitted` | `cap_drop: [ALL]` | Do not drop `CHOWN`, `SETUID`, `SETGID`, `DAC_OVERRIDE` |
| A malformed JSON body gives `404 "Cannot POST /api/sessions"` | OpenWA renders a body-parser error as a missing route | A client bug: send valid JSON |
| A `400` is only `{"message":"Bad Request"}` | Production hides field detail (`VALIDATION_ERROR_DETAIL` is off) | Switch it on in development; the app reads `message` as a string or a list |

## Where reality differs from the reference (recorded on 0.23.7)

Everything else in [reference/openwa-api.md](reference/openwa-api.md) that could be tried matched. The differences, precisely:

1. `POST /api/sessions/{id}/start` **blocks** until the engine waits for a scan (6-25 s) and answers `status: "qr_ready"`; the reference says it "typically transitions to initializing / qr_ready". While it runs, `GET /api/sessions/{id}` says `initializing` and `GET .../qr` answers `400 "QR code is not ready yet. Please wait..."` (fixtures `sessions-start`, `sessions-get-initializing`, `sessions-qr-initializing`).
2. A key scoped by `allowedSessions` that addresses another session gets **401** `"API key not authorized for this session"`, not 403 (`auth-scoped-other-session`). Creating a session with such a key is 403 as documented.
3. `send-text` while the engine runs but is not connected is **409** `"Session is not connected. The WhatsApp client is not ready."` (`messages-send-text-session-not-ready`); not started is a 400 with its own text (`messages-send-text-session-not-started`).
4. A **malformed JSON body** answers `404 {"message":"Cannot POST /api/sessions"}` (`sessions-create-malformed-json`), not 400.
5. Production validation errors carry **no `error` field** (`{"message":"Bad Request","statusCode":400}`); with `VALIDATION_ERROR_DETAIL=true` they are `{message: [...], error: "Bad Request", statusCode: 400}`. A non-UUID session id is `400 "Validation failed (uuid is expected)"` on GET / start / stop, but the messages routes do not parse it.
6. The `test` webhook event has the idempotency key `evt_test_<12 hex>` and `data {message, webhookId, url}` (the reference: `test_<deliveryId>_<webhookId>`).
7. Webhook responses carry `sessionId` = the session **UUID** (the reference examples show a name).
8. A **302** from the receiver is a failed delivery with `lastError "Destination address is not allowed"` (not followed); a timeout has `lastStatusCode: null` and `lastError "The operation was aborted due to timeout"`.
9. The throttler numbers (10 per second, 100 per minute, 1000 per hour) and its exact 429 body (`message: "ThrottlerException: Too Many Requests"`, no `error`) are not in the reference.
10. `session.qr` refreshes about every **60 s**; the QR is a 276x276 PNG of about 4.7 KB.
11. `AUTO_START_SESSIONS` and `RESOLVE_LID_TO_PHONE` both default to **false**.
12. The first running session needs 550-800 MiB (the earlier estimate was 300-500 MB).
13. Unknown routes answer 404 **before** the key check (no 401 without a key); `Authorization: Bearer <key>` works like `X-API-Key`; `GET /api/health` shows the `version` only with a key; `/api/docs` is a 404 although the start log advertises it.
14. **Not verifiable here** (needs a paired phone), still documented-only: every `message.*` payload and ack, `SEND_PACING_LIMITED`, `SESSION_NAME_TEARDOWN_PENDING` (a never-paired session can be deleted and re-created under the same name at once), the media download of a real message, the error text of `GET .../qr` on a `ready` session.

## Testing without a phone

| Tool | What it is |
|---|---|
| `scripts/openwa-record.mjs` | Re-records the fixtures from the running container (`node scripts/openwa-record.mjs`; `--strict-base=http://127.0.0.1:8370` with an optional second container for the no-allow-list and validation-detail cases; `--only=sessions,webhooks`; `--index-only`). |
| `scripts/openwa-smoke.mjs` | The human check for **any** OpenWA: `OPENWA_API_KEY=... node scripts/openwa-smoke.mjs --base=https://wa.example.com --webhook-url=<the address the app registers>` (or `--receiver-port=8368` for a signed delivery end to end; `--no-start` skips the engine). Prints PASS / WARN / FAIL / SKIP, gives the hint for an SSRF refusal, cleans up after itself and never prints a key. |
| `e2e/support/openwa-mock.mjs` | The stateful mock the e2e suite is written against (see [testing.md](testing.md), "P6 WhatsApp"); `node --test e2e/support/openwa-mock.test.mjs` proves it against the fixtures. |

### Fixture catalogue (`tests/fixtures/openwa`; `index.json` lists every file)

Each file says `source: recorded` or `source: documented`. Recorded files hold `request` / `response` (status, selected headers, body, duration) or, for a webhook delivery, the exact headers and raw body plus a `verification` block (the secret is a fixed test value, so signatures can be re-checked). Keys read `owa_k1_REDACTED`, QR images `data:image/png;base64,<REDACTED>`.

| Group | Files | Source |
|---|---|---|
| System | `system-health`, `system-health-authenticated`, `system-health-ready`, `system-engine-current`, `recording-meta` (version, digest, env, rate limits, start timings) | recorded |
| Keys and roles | `auth-validate-ok`, `-missing-key`, `-invalid-key`, `-viewer`; `auth-create-key-response`, `auth-viewer-create-session-forbidden`, `auth-operator-create-session-ok`, `auth-scoped-create-session-forbidden`, `auth-scoped-own-session-ok`, `auth-scoped-other-session` | recorded |
| Sessions | `sessions-create`, `-create-duplicate`, `-create-name-too-short`, `-name-characters`, `-name-too-long`, `-missing-name`, `-unknown-property`, `-malformed-json`, `-create-after-delete`; `sessions-list`, `-list-name-filter`, `-list-name-miss`, `-get`, `-get-not-found`, `-get-not-uuid`, `-delete`, `-delete-twice`, `-delete-running` | recorded |
| Lifecycle and QR | `sessions-start`, `-start-twice`, `-get-initializing`, `-get-qr-ready`, `-qr`, `-qr-before-start`, `-qr-initializing`, `-qr-after-stop`, `-stop`, `-stop-twice`, `-stop-never-started` | recorded |
| Webhook management | `webhooks-create`, `-create-default-events`, `-create-ssrf-loopback`, `-ssrf-localhost`, `-ssrf-private-ip`, `-ssrf-metadata-ip`, `-url-credentials`, `-secret-too-short`, `-unknown-event`, `-unknown-session`, `-create-limit`; `webhooks-list`, `-list-all-sessions`, `-list-deleted-session`, `-get`, `-get-not-found`, `-get-after-delete`, `-update`, `-delete`, `-test`, `-delivery-failures` | recorded |
| Second instance (no allow-list, validation detail) | `strict-sessions-create-*`, `strict-webhooks-create-secret-too-short`, `strict-webhooks-create-ssrf-no-allowlist`, `strict-messages-send-text-empty-chat` | recorded |
| Signed deliveries | `webhook-delivery-session-status-initializing`, `-qr-ready`, `-disconnected`, `webhook-delivery-session-qr` (QR scrubbed, so not re-verifiable), `webhook-delivery-test`, `webhook-delivery-retries` (attempt offsets) | recorded |
| Messages | `messages-send-text-session-not-started`, `-session-not-ready`, `-empty-text`, `-too-long`, `-unknown-property`, `messages-media-not-found` | recorded |
| Rate limit | `ratelimit-throttled` | recorded |
| Inbound payloads | `delivery-message-received-text`, `-text-baileys`, `-image-inline`, `-image-omitted`, `-group`, `-lid`, `-from-me`, `-status`, `-channel`, `-document`, `-voice`; `delivery-message-sent-echo`; `delivery-message-ack-sent` / `-delivered` / `-read`; `delivery-message-failed` | documented |
| Session events | `delivery-session-authenticated`, `-status-ready`, `-disconnected`, `-reconnect-loop` | documented |
| REST answers needing a phone | `messages-send-text-ok`, `sessions-get-ready`, `sessions-get-failed`, `messages-media-download-ok` | documented |
| Errors needing a phone | `error-send-pacing-limited`, `error-session-name-teardown-pending`, `error-session-start-timeout`, `error-session-stop-incomplete` | documented |

## Hand-off flow (summary)

1. The widget offers the built-in chat or WhatsApp (only when `availability.whatsapp.enabled && features.whatsapp`).
2. `POST /api/v1/public/widgets/{key}/whatsapp-handoff {category?}` (visitor bearer) returns `{code, waUrl, expiresAt}`: an **8-character** code (alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, example `K7M2QX4P`) and `https://wa.me/<number>?text=Hi! My support code is <code>`.
3. The visitor sends the first message; the webhook processor's `ChatLinker` matches a live ticket code in the first inbound messages and attaches widget, visitor and topic to the chat. An unmatched chat is still recorded; groups are ignored by default.
4. An administrator replies from the WhatsApp inbox (`send-text`); acks update the ticks.

Tables: `whatsapp_sessions`, `wa_handoff_tickets`, `wa_chats`, `wa_messages`, `wa_webhook_deliveries`. Everything is admin-only: routes, Inertia pages, the `private-whatsapp-admin` channel, search and export answer 403 or hide data for agents (a P6 exit criterion, covered by the isolation tests and `e2e/whatsapp/smoke.spec.ts`).
