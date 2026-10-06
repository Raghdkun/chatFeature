# Changelog

> Status: living document; updated at the end of every phase gate.

All notable changes are recorded here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project uses phase tags `v0.N.0` until `v1.0.0` (P8).

## [Unreleased]

### Fixed (full real-browser verification, 2026-10-05; see [feature-verification.md](feature-verification.md))

Six verifiers drove real Chrome through every feature on isolated instances (902 checks, 85 findings); what they found and was fixed:

- **Sign-in and accounts**: signing in with `/inbox` as the intended page left a blank white page (the staff session is learned one commit after the first page rendered; the inbox shell now waits for it); a password change or reset now ends the **pages** of every other session of the account (`AuthenticateStaffSession` in the web group; the changer's own session stays), where before only the old tab's background calls got 401 and the tab reloaded itself in an endless loop; one wrong code while enabling two-factor no longer destroys the pending secret (an unconfirmed setup is abandoned after 15 minutes, not on the next page load; the wrong digits are cleared); "Forgot password" answers the same for every address (it told strangers which e-mails have an account); the only administrator can no longer delete their own account; deleting an account removes its API tokens and hands its active chats back to the queue; a throttled dashboard form (sign-in, two-factor code, reset) goes back to the form with "Try again in N seconds" instead of opening a bare 429 box; `/history?q[]=1` is no longer a 500; the 2FA setup dialog and challenge have accessible names; the RTL switch thumb stays inside its track; the wizard's app URL must be an origin (no path or query) and its "change this later in Settings" promise is now honest.
- **Presence**: logging out takes the agent offline at once (it took up to 90 s), and so does deactivating one; the Agents page "Last seen" works (it read a column nothing wrote; presence changes write it, an online agent shows "Active now"); a push subscription run is single-flight (the dashboard's automatic run and the "Turn on" button could register the same browser twice).
- **Chat**: the panel says "Chat closed" (not "Thanks for your feedback!") when the server refused a late rating; images staged and removed from a message no longer block the chat after ten rounds (the uploader's oldest unused uploads make room); the rating comment is visible in the History table (it was a tooltip only); a chat the agent just transferred away is not read again (403 in the console); contrast of finished chats in the inbox and of the "Seen" receipt.
- **Widgets and builder**: a long word or URL in an admin-written panel text wraps instead of being clipped; the builder preview can load a custom font (Google Fonts and Bunny Fonts are allowed in the dashboard CSP `style-src`/`font-src`/`connect-src`, nothing else); the Hours tab and the Embed tab say whether chat is open right now (new widgets follow business hours, which silently showed the offline form); a double click on "Publish now" publishes once; the default accent is `#D97706` (the old amber failed 3:1 on white and showed a red warning on every new widget); stopping an admin from taking chats asks first (it deletes their categories); the staff password hint tells the production rule; two topics cannot share a name; names an administrator types lose bidi overrides and line breaks; the consent hint no longer says the button is disabled.
- **WhatsApp**: a momentary OpenWA 409/429 is asked again twice on the sync queue (it failed the reply for good); the failure text no longer shows "ThrottlerException"; the transcript uses WhatsApp's own time for the clock, the day dividers and the order; "Remove the saved key" asks first; a stale failure reason no longer sits under a Starting or waiting-for-scan session; the inbox filters fit a 50-character session name; a malformed OpenWA address (credentials, a path) gets its own message.
- **Security and hygiene**: the hardening headers (`nosniff`, `no-referrer`) now also reach API 401/404/405 answers; non-web page URLs (`javascript:`) are dropped when a visitor session starts; Inertia DevTools (which serve every page's props without a sign-in under `APP_ENV=local`) are off in `.env.example`; the tab title carries the app name chosen in the wizard; the collapsed sidebar shows the attention count on the icon; `analytics:rollup --days=N --force` rebuilds sealed days; the analytics page hides the empty WhatsApp card until WhatsApp was ever set up.

### Fixed (real-browser pass, 2026-10-05)
- **The chat bubble opened an empty panel under `composer dev` / `npm run dev`**: `embed.blade.php` loaded its entry with `@vite(...)` but without `@viteReactRefresh`, so every module threw `$RefreshSig$ is not defined` and the panel never started. The built assets (and so the whole e2e suite) were unaffected. Regression test in `HardeningTest`.
- **The widget builder's live preview was dead in production** (`CSP_MODE=enforce`): its `srcdoc` document inherits the dashboard policy and its inline scripts had no nonce. The page now exposes its CSP nonce in `<meta name="csp-nonce">` and the preview puts it on both inline scripts.
- Dev server-side rendering aborted (`renderToString does not support Suspense`) because the WhatsApp realtime gate suspended during the first render; the engine is now requested after the first client render.
- A stray debug write to a scratch file in a session-controller test (left by an e2e agent) made the Vitest run fail on any other machine.
- WhatsApp: a session sync no longer drops the reason of a failure when the `failed` webhook (which carries none) overtook it; this was the cause of the flaky `views-responsive` spec (3 failures in 3 runs once the timing shifted). An answer that would MOVE a session a newer webhook already moved is still dropped.
- The widget builder's "live" badge was `nowrap` and, with its new wording, wider than a 320 px screen; it wraps now.
- Branded error pages (403, 404, 419, 429, 500, 503) with a way back replace Laravel's bare "403 | message" line; the first-login notification explainer waits while another dialog is open instead of opening over it.

### Changed (first-run experience)
- The dashboard checklist is read from the real configuration (category, widget published, somebody serves a category, widget live with an allowed site), each row links to the page where the step is done and says what is missing; the live queue and the online team are real; an administrator who takes chats gets the availability control.
- The administrator created by the wizard serves the seeded "General" category; an agent who serves no category is told why chats never reach them (dashboard and inbox) instead of visitors silently getting "No agent is available".
- The widget card and the Embed tab say when the widget is switched off or has no allowed site (the panel is refused by `frame-ancestors 'none'`); the "Changes here apply immediately" badge now says "Takes effect when you save (no Publish needed)", because domains need Save; the builder opens on `?tab=`.
- Analytics: the page has a title in the top bar; a new installation no longer announces a month of numbers "being prepared" (days before the first chat are empty by definition).
- Docs: the Reverb-port clash (Homebrew Apache on 8080) and the empty-bubble causes are in `running-the-app.md`; [pending-from-you.md](pending-from-you.md) lists what only a person can do.

### Added
- **Deployment behind the nginx + certbot a server already has** ([deployment-vps-nginx.md](deployment-vps-nginx.md)): `compose.nginx.yml` (an override of `compose.prod.yml`: the stock `caddy` edge is switched off, a plain-HTTP `web` service on `127.0.0.1:${PROXY_PORT}` takes over), `docker/caddy/Caddyfile.proxy`, the routing split into `docker/caddy/routes.caddy` (shared by both Caddyfiles, so the two modes cannot drift), `docker/nginx/pne-chat.conf` (websocket, upload size, forwarded headers, big proxy header buffers; certbot completes it), `scripts/init-env.sh --nginx`; `scripts/backup.sh` and `scripts/restore.sh` now take the compose files from `COMPOSE_FILE` in `.env` (a colon-separated list) and stop whichever edge service the stack has. Tested on a laptop with an nginx container: two real bugs found and fixed (the `caddy` binary needs `NET_BIND_SERVICE` even behind a proxy, nginx's default header buffer turns every dashboard page into a 502 because of the ~5 KB `Link: rel=preload` header).
- **Production Docker image, compose stack, Caddy, backup scripts and the Hostinger guide (P8, 8A/8B)**: a multi-stage `Dockerfile` (php-fpm 8.4 on Debian with `ext-uv`, `ext-redis`, GD and no compiler toolchain, 422 MB; the frontend stage builds with pnpm, runs the Wayfinder PHP step and the loader size check; a Caddy `web` image that carries the `public/` of the same build), `compose.prod.yml` (caddy, app on a php-fpm unix socket, queue, scheduler, reverb with `nofile` 65 536, nats-consumer, mysql 8.4, redis 7, optional OpenWA pinned by digest and NATS; read-only root file systems, no capabilities, health checks, rotated logs, three networks), `docker/caddy/Caddyfile`, `.env.production.example`, `scripts/init-env.sh`, `scripts/backup.sh` (encrypted dump + storage + OpenWA volume, retention, off-site hook) and `scripts/restore.sh`, and the rewritten [deployment guide](deployment-hostinger-kvm.md). Run locally on Docker (arm64, `tls internal`): wizard over https, a chat reaching an agent over `wss://` through Caddy, scheduler, queue, restarts, `migrate --force`, 2 500 websockets through Caddy (Reverb on `ExtUvLoop`, 1 513 descriptors at 1 500 sockets), an encrypted backup, destroying every volume and restoring. The amd64 `app` image was built under emulation and smoke-tested. Not verified: real Let's Encrypt, a real Hostinger VPS, a WhatsApp phone, a real pizzasys portal.
- The NATS consumer was run against a real NATS 2.11 JetStream server (Docker) for the first time: both integration tests pass (stream ensured, durable pull consumer, ack, de-duplication, malformed/unknown handling, redelivery after a nak); one assertion in the test (a stored-row count) was a wrong guess and was corrected.

## [0.7.0] - 2026-10-02 (phase-7)

Reporting, API documentation, native-app readiness and a security sweep. Built as four parallel tracks (analytics, API docs + mobile, hardening, native sign-in) on top of P5/P6 and merged on `integrate/phase-5`, together with the P5 and P6 e2e suites (see 0.5.0 and 0.6.0: all three phases share one gate and one commit, tagged `v0.5.0`, `v0.6.0` and `v0.7.0`).

### Added
- **Analytics** (`app/Domain/Analytics`, [analytics.md](analytics.md)): `analytics_daily` / `analytics_slots` rollups built by `analytics:rollup` (hourly for today and the two days before, nightly catch-up of 35 days, `--from/--to/--force`; days older than 3 days are sealed), one calculator for the rollup and the live "today". Metrics: started/handled/ended/closed by reason/missed/cancelled, wait, first response, handling time, resolution, ratings (1-5), messages, offers, offline tickets, peak concurrency and queue peak, per widget/topic/agent, busiest hours in the viewer's time zone, and an admin-only WhatsApp section. API `/api/v1/analytics/*` (overview, timeseries, breakdown, heatmap, ratings, whatsapp, export CSV) and the `/analytics` page (key numbers with deltas, four charts, heatmap, ratings, breakdowns, filters, presets, CSV export; each chart has a text alternative and "view as table"). **Agents see only their own numbers** (the server scopes them: `agent=<other>` is 403, no colleague names, no WhatsApp, no visitor comments). Reconciliation tests compare every stored cell with an independent reference over a generated dataset (UTC, Europe/Berlin across a DST change, Asia/Kolkata), on SQLite and on MySQL.
- **API reference** ([rest-api.md](rest-api.md), [api-guide.md](api-guide.md)): Scribe-generated OpenAPI for the management and the public API (`composer docs:api`, `docs:api:check`; `docs/api/openapi-*.yaml` are committed, `public/docs` is built and git-ignored), examples and schemas generated from the Data classes, request fields from the Form Requests, and a rot guard (`ApiDocsGuardTest`: every `api/v1` and webhook route needs an entry, every error code a catalogue row, and the committed files must be what the code generates). A small validator runs real flows against the committed schemas.
- **Native staff app** ([mobile-readiness.md](mobile-readiness.md)): `POST /api/v1/auth/token` and `/auth/token/two-factor` (password, then a single-use challenge for accounts with two-factor, both auth modes, one identical answer for unknown/wrong/inactive/no-role, one slow hash per refusal, shared login throttle with the web, stateless, `no-store`, size-capped, audited without secrets), `GET /auth/me`, `GET/DELETE /auth/tokens`, `POST /auth/logout` (revokes the current token only). Passkeys for native sign-in are deferred.
- **Stale-socket cut-off** ([realtime.md](realtime.md)): every private-channel subscription is signed with an opaque principal tag; when a right ends (deactivation, demotion, role/permission change, category unassign, transfer/close/claim loss, visitor token rotation/revoke) the Reverb control API closes that principal's sockets (`SocketCutOffSubscriber`, `realtime_grants`, parked retries swept by `chat:realtime-sweep` every minute).
- **Security headers**: a per-request-nonce Content-Security-Policy for the dashboard (`CSP_MODE=enforce|report-only|off`, enforce in production), `/csp-report` collector, Permissions-Policy, COOP, HSTS over https only; route classification and behaviour matrices over the real route table (every route classified, 401/403/404/CSRF/CORS/BOLA proven); an upload fuzz corpus (86 cases) for the image pipeline.
- **Privacy**: `chat.retention_days` with the daily `chat:prune-conversations`, `chat:erase-visitor` and `DELETE /api/v1/visitors/{ulid}` (refused while a chat is open, audited, idempotent), `GET /api/v1/visitors/{ulid}/export` (data-subject access), `GET/PUT /api/v1/privacy/retention`.
- **Query review and load test** ([runbook.md](runbook.md)): history search 35 s -> 0.9 s on 50 000 conversations / 498 000 messages (uncorrelated `IN` instead of correlated `EXISTS`), WhatsApp search 18.7 s -> 0.10 s, three indexes; 1000 visitor sockets + 20 agents on one Reverb: 0 failures, Reverb 18% of a core, 110 MB (see the runbook for the p50/p95/p99 and the caveats).

### Changed
- The Scribe `/docs` route is gone (the reference is static); `docs/rest-api.md` corrected (no login/profile/analytics-audit endpoints existed under the names it listed).
- `ImageSanitizer`'s memory budget was too low (measured 11 to 13 bytes per pixel, now 14).
- Search: `ConversationSearch` and `WaChatSearch` use uncorrelated subqueries.
- Never flashed back into a rejected form: `code`, `recovery_code`, `challenge`.

### Notes
- Gate (the single P5-P7 gate on `integrate/phase-5`): PHPUnit 4515 (25 skip: harness, NATS, MySQL, Redis-gated groups), Vitest 3071, PHPStan L7, Pint, `vp check`, `tsc`; MySQL-gated suites green per track. Playwright, full run (about 31 minutes, ~1200 specs on desktop and mobile): 1163 passed, 2 flaky (passed on retry), 32 skipped, 1 failed: the responsive Settings > WhatsApp spec (375/320 px) fails under full-suite load and passes alone (`e2e/whatsapp` by itself: 197 passed, 9 skipped); the portal-outage project is skipped by Playwright when any other spec fails, so it was run alone and passes. The first full run had found 25 failures: 24 were specs written against code from before the fix round (new `ttlSeconds`, heartbeat answers 200, push `type`, admins on the WhatsApp channel, body-hash ledger keys, a gateway 502 now leaves a reply unconfirmed instead of failing it) and one was a real bug (the WhatsApp "delete chat" button was unreadable in dark mode). Loader 16.44 KB of 18 KB.
- New env settings: `CSP_MODE`, `ANALYTICS_*_TTL`, `WHATSAPP_WEBHOOK_RATE_PER_NETWORK` / `_PER_SESSION` (defaults 6000 / 3000 a minute; the e2e sets 600 so the flood spec is cheap).
- Process: each track was built in its own worktree with its own database and ports; four tracks hit the API rate limit or a stalled stream once and were resumed.

### Known gaps / backlog
- **Reverb needs `ext-uv`** above about 1000 sockets: without it Reverb (stream_select, FD_SETSIZE 1024) tops out near 1013 and then **exits with status 0 and no message**. The production image must install `ext-uv`, set `ulimits nofile 65536`, `restart: unless-stopped` (not `on-failure`), and `REVERB_APP_MAX_CONNECTIONS` where it is missing (P8).
- Not measured: several Reverb instances behind Redis, TLS through Caddy, real browsers, a queue worker, Redis cache, php-fpm. At about 40 sends/s the application tier (not Reverb) saturated on the test laptop.
- The public POST endpoints have no CORS support (a third-party browser front end must proxy through its backend or use the iframe).
- Native sign-in: passkeys and a refresh endpoint are not implemented; FCM push is still a stub (a real channel needs the seven items in mobile-readiness.md); an agent whose app is in the background reads offline after 90 s.
- Analytics: no browser/Playwright check of the charts at 320 px; one filter at a time; the first view after an upgrade needs `analytics:rollup --from=...` for days older than 35.
- Local MySQL in the dev machine runs in the system time zone; production MySQL should run in UTC.
- Open from the e2e: an agent gets 403 for a real WhatsApp id and 404 for a made-up one (an existence oracle, `test.fixme`); the admin WhatsApp channel has no catch-up at connect; tabs of one visitor opened in the same instant do not all settle on the live chat (`test.fixme`).

## [0.6.0] - 2026-10-02 (phase-6)

WhatsApp through the self-hosted OpenWA gateway: hand-off, recording and an admin-only inbox. Developed in parallel with P5.

### Added
- **Backend** (`app/Domain/WhatsApp`, `app/Infrastructure/OpenWa`): sessions (create/start/stop/delete, QR), the webhook `POST /webhooks/openwa/{session}` (raw-body HMAC `X-OpenWA-Signature: sha256=<hex>`, event/key/delivery id read from the signed body only, delivery ledger, replay command `whatsapp:replay-deliveries` every 5 minutes, events of one session applied one at a time under a lock), `ChatLinker` with 8-character hand-off codes, groups ignored, `SendReply` with pacing, a daily cap, replies only to chats the customer started, and a write that was sent but not answered is never repeated; `OpenWaHttpClient` with the shared SSRF guard (`PORTAL_ALLOW_PRIVATE_HOSTS`); media pipeline; WhatsApp retention settings.
- **Admin UI**: Settings > WhatsApp (sessions, QR dialog, connection test, sending limits, webhook address), the admin-only inbox (list, conversation with pictures/documents/links and delivery states, linked-chat details, search, export, archive), the builder's WhatsApp tab and the widget's channel chooser with the `wa.me` hand-off screen.
- **Admin-only everywhere** (`wa.admin`, `WhatsAppPolicy`, channel `private-whatsapp-admin`): an agent gets 403 on every route, page, action, channel and search (a 217-case isolation matrix).
- **Tests and ops**: a stateful OpenWA mock (`e2e/support/openwa-mock.mjs`) for e2e, the real OpenWA image (0.23.7, digest pinned in `docker/compose.dev.yml`) run to record fixtures, [whatsapp-openwa.md](whatsapp-openwa.md) (the verified operations guide), `docs/reference/openwa-api.md`.
- **P6 e2e** (`e2e/whatsapp`, scenarios `p6-wa` and the Arabic twin `p6-wa-rtl`): 206 tests per full run (103 per project), session lifecycle and QR, webhook security, inbound/outbound, hand-off, builder, isolation, resilience, axe/375 px/RTL/keyboard sweeps; the last three full runs were green; 44 deck screenshots (`docs/screenshots/p6`).

### Fixed (found by the e2e)
- A session's webhook events arriving together could leave the wrong status (now serialised per session).
- The QR dialog's Start on a stopped session did not show the code again; Back on the hand-off screen kept the old topic on multi-topic widgets; confirmation dialogs and the archive button lost keyboard focus; export links under the 24 px target size; contrast and a 375 px overflow.
- The first presence write by two agents deadlocked on MySQL (see 0.5.0; both e2e agents found it, one fix kept).

### Known gaps
- Message-level payloads (`message.*`, acks) of the real OpenWA image and a round trip through a real phone were never recorded (checklist in the operations guide); the 10-hand-offs-a-day cap is shadowed by the per-visitor limiter; sends are not retried by a real queue in e2e (`QUEUE_CONNECTION=sync`).
- A chat the phone started cannot be answered from the inbox (the locked "reply only to customers who wrote first" rule); the session status can flicker qr -> starting -> qr once; the chat-list cursor carries the integer primary key (not exposed as an id).

## [0.5.0] - 2026-10-02 (phase-5)

Presence and notifications: who is online, who gets told, and the visitor's bubble that shows a reply. Developed in parallel with P6.

### Added
- **Presence** (`app/Domain/Presence`): a `PresenceStore` on Redis (hash + sorted set, Lua) with an automatic fallback to the database (the failure cooldown is shared across requests), a mirror row, one effective-status policy (a manual choice wins; heartbeat window 90 s; automatic away after 5 hidden minutes; Redis record lifetime 180 s), `chat:presence-sweep` every minute, a heartbeat that answers the effective status. Routing, availability, roster, transfer targets and the inbox read presence only through it. UI: presence dots on the agents page, the inbox hint with a one-click "Go online".
- **Web push** (`laravel-notification-channels/webpush`): VAPID, `public/sw.js`, the manifest route, a first-login permission dialog (explainer first, the permission is requested on a click), Settings > Notifications (this browser, sound, kinds, quiet hours, "Show message text"), the endpoint guard (public hosts only, `push.allowed_hosts`) and `PushHttpClient` (connection pinned to the judged address, no redirects, a deadline), dismiss pushes with the same tag when another agent accepts or the chat is read, quiet hours (the same matrix in PHP and TypeScript), previews off by default (`notifications.push_include_preview` AND the member's choice). The OS notification of an open background tab goes through the service worker too. `FcmChannel` stub, `device_tokens`, `POST /me/devices`.
- **Visitor bubble**: unread badge on the launcher and a reply alert (shake/pulse and a sound), coalesced over 8 s, synchronised across tabs of one visitor, silent while the host keeps the launcher hidden. Loader budget raised to **18 KB** (16.44 KB used).
- **P5 e2e** (`e2e/p5`, scenarios `p5-chat`, `p5-presence-redis`, `p5-presence-failover`, `p5-notify`, `p5-notify-rtl`): 95 tests per project, with a fake push service (an HTTPS proxy for `fcm.googleapis.com`; delivery is asserted end to end: VAPID JWT, RFC 8291 decryption, TTL/urgency/topic, 410/404 pruning, 5xx keeping) and the real `sw.js` fed the server's own payloads; 26 deck screenshots.

### Fixed (found by the e2e)
- First presence write, first push subscription and first device registration deadlocked on MySQL (500 for the loser): `DeadlockRetry`.
- The Redis failure cooldown was forgotten with every request (one warning and one Redis attempt per call).
- A read receipt sent with a rotated-away token got 404 and was dropped (the agent never saw replies read).
- The OS notification for a visitor message showed the previous message's words.

### Known gaps
- Clicking a real OS notification, a browser rotating its own subscription, a real vendor push service and the real permission prompt cannot be automated (they are dispatched inside the worker or stubbed); Firefox, Safari and WebKit were not run.
- Closing any Chrome context wipes the notifications Chrome still shows, so the three display specs run under a lock and tolerate a wipe (documented in testing.md).
- Tabs of one visitor loaded in the same instant all resume from one stored session and settle on the pre-chat form (`test.fixme`); the visitor is not harmed (starting a chat answers with the running one).

## [0.4.0] - 2026-10-01 (phase-4)

The live-chat core: a visitor starts a chat from the widget, every eligible online agent is offered it, the first to accept wins, and the two talk in realtime (typing, delivered/seen, images) until the chat is ended and rated. Built as a spine (shared schema/contracts), four parallel tracks, two independent review rounds with fix rounds, and a real-stack e2e suite.

### Added
- **Schema and domain** (`app/Domain/Chat`, `Visitors`, `Presence`): `visitors`, `visitor_sessions`, `conversations`, `conversation_events`, `conversation_agent_alerts` (offers), `messages` (per-conversation `seq`, idempotent `client_msg_id`), `attachments` (with `position`), `ratings`, `agent_presence`; the conversation state machine (`queued -> active -> ended -> closed`, `missed`, offline tickets as separate rows), `ConversationPolicy`, `Conversation::visibleTo`, 19 domain events, visitor-safe vs staff Data classes (generated TypeScript).
- **Routing**: offers go to active agents who serve the category, are online/away (heartbeat within 90 s) and under `max_concurrent_chats`; waves come from the widget's `config.routing.waves` (default online at 0 s, away after 20 s); first Accept wins through one guarded `UPDATE` (a re-accept by the winner is idempotent); queue timeout -> `missed` -> offline form -> offline ticket (claimed, answered by e-mail, closed); transfer to a colleague or a category with a reachability check (`409 no_agents`); deactivated or demoted agents' chats are requeued.
- **Public API** (`/api/v1/public`, bearer `vt_...` visitor tokens, no cookies): sessions (signed identity, token rotation with a 60 s overlap, `limits` for the panel), conversations, messages (`after_seq`), attachments (images only), receipts, typing, end/cancel, rating/skip, offline tickets, signed attachment URLs, broadcasting auth. **Management API**: conversations (filters, FULLTEXT/LIKE search shared with the history page, cursor paging), queue, claim, messages, attachments, receipts, typing, end/close/transfer, `transfer-targets`, CSV/JSON export (admin, audited), presence.
- **Jobs and commands**: `chat:expire-queued`, `chat:offer-waves`, `chat:close-idle`, `chat:close-unrated` (every minute), `chat:prune-visitor-sessions` (daily); a delayed `ExpireQueuedConversation`/`OfferNextWave` per chat (epoch-guarded). **The scheduler (`schedule:work` or cron) must run in production.**
- **Realtime (Reverb)**: channels `staff.{id}`, `presence-staff`, `conversation.{ulid}`, `admin` (authorised through the policy; visitors only through their own bearer endpoint), 19 events (`message.created` published immediately, the rest queued, `message.delivered`/`message.seen`, `conversation.missed`, `typing` fallback), failure isolation (a Reverb outage never breaks the HTTP request), redacted logs, allowed origins pinned to the app origin, `REVERB_*` env documented in `.env.example`, a real-socket smoke script (`npm run realtime:smoke`). The dashboard learns the Reverb address at runtime from the `realtime` shared prop.
- **Agent dashboard**: `/inbox` (queue with offer cards and countdown, my chats, unseen badges and tab title, conversation view with date separators, receipts, typing, lightbox, composer with attachments, end/transfer/copy transcript, presence selector with heartbeat), `/history` (admin: filters, search, ratings, paging, export), `/offline-tickets` (claim, reply, close); REST polling fallback when the websocket is down; phone drill-down layout.
- **Visitor panel** (inside the widget iframe): pre-chat, topic picker, queue with cancel, live chat (optimistic send with retry, receipts, typing, image attachments with lightbox, safe auto-linking), rating, offline form, closed screen, reconnect/visibility/gap sync, polling fallback, error boundary, host `startChat`/identity API, the compare-and-clear session protocol between tabs, English + Arabic built-in texts.
- **Tests**: PHPUnit and Vitest for every layer (counts in the Notes), a MySQL-gated concurrency suite (12 parallel claims -> exactly one winner), and a real-stack Playwright suite for the chat (`e2e/chat`, real Reverb per scenario, real customer-site page): lifecycle and routing, visitor resilience and identity, staff inbox and history, permission/IDOR matrices, channel authorisation with a real `pusher-js`, rate limits, polling-only mode, axe (light/dark, desktop/phone), 375/320 px, RTL, keyboard, performance, and the deck screenshots (`docs/screenshots/p4`).

### Changed
- `availability.online` is real now (presence-based, per category, following the widget's wave plan); the P3 builder preview runs the real panel on canned data.
- Visitor sessions: a rotated token's predecessor expires 60 s later; signing out revokes every session of that visitor; a chat start is limited per widget and network, after a cancel and by queued chats per network.
- `ConversationStaff` carries `queueExpiresAt`, `pageUrl`, `pageTitle`; `chat.offered` carries `ttlSeconds` (count down from the browser's own arrival time, never trust its clock).
- Signed attachment URLs live 240 minutes and are built from the configured app origin, not the request host.
- In mode 2 agents' names shown to visitors never fall back to an e-mail address.
- `/w/<key>.js` stays as in 0.3.0; the loader is 15.8 KB of its 16 KB budget (only about 200 bytes of headroom left).
- `BROADCAST_CONNECTION=reverb` in `.env.example`.

### Security (from the independent reviews)
- Token rotation no longer leaves the old token alive (stolen-token takeover of an open chat); `external_id` is compared case/accent-sensitively (binary collation); animated GIFs are refused and decoding never expands frames (pixel/memory bomb); the raw-byte markup scan that rejected genuine photos was dropped (the image is re-encoded, so polyglots do not survive); per-widget chat-start/offline-ticket budgets, a cancel cooldown and a per-network queue cap; a per-network limiter in front of every visitor route; a per-conversation attachment quota; `mailto:` links are encoded; staff `linkify` rejects credentialed URLs; the panel pins its API origin to the inlined app origin; CSV formula injection neutralised; visitor names are stripped of control characters in mail.

### Fixed (found by the e2e)
- Visitor panel: socket-close console error on every ended chat; a message burst unpinned the list; the older of two tabs lost its chat after a token rotation; Cancel sometimes ended on the offline form; a stale poll flipped a claimed chat back to queued; receipts of the visitor's own messages never refreshed after a poll.
- Backend: the loser of a simultaneous Accept got `403` instead of `409 already_claimed`; a MySQL deadlock on first-time verified sessions answered `500` (now retried); a hand-made list cursor answered `500` (now `422`); `DeadlockRetry` also catches nested-transaction deadlocks.
- Dashboard: sorting of conversations changed in the same second, stale ticks after a catch-up, focus loss on queued -> active, dialogs not returning focus, phone overflow of long names/tokens, blank lazy images, history filter bar overlap, contrast and target-size findings, `dir="auto"` on message text, delivery receipts never broadcast live (`message.delivered` added), attachment order inside a message (`position`).

### Notes
- Gate: `composer ci:check` green (Pint, PHPStan L7, 2418 PHPUnit with 14 skips for the harness/NATS/MySQL-gated groups, `vp check`, `tsc`, 2183 Vitest); MySQL-gated Chat suites green (incl. 12 parallel claims -> one winner); Playwright 803 specs: 787 passed, 16 skipped (phone-only skips, open `fixme`s), 0 failed, 0 flaky (the whole suite takes ~17 minutes on a quiet machine; the global timeout is 2.5 h). Loader 15.8 KB of 16 KB.
- Staff sessions: `api/*` and `POST /broadcasting/auth` no longer write the session (found by the P3 specs after P4: background reads overwrote flash messages, `url.intended` and the revoked-session notice); `GET /session/keepalive` extends the lifetime every 20 minutes.
- Review process: four independent read-only reviews (backend correctness 14 findings, security 10 findings, frontend 26, front/back audit 17) and two fix rounds; `/security-review` and `/simplify` cannot run on this machine (they shell out to the blocked system git).
- The deck screenshots of P3 must be regenerated for the deck (`E2E_SCREENSHOTS=1`): the git-ignored P3 folder was lost with a removed worktree.

### Known gaps / backlog
- Animated GIFs are refused (a chat image is a still); a visitor's socket and a deactivated agent's open socket keep receiving channel events until they disconnect (documented, P7: Reverb control API or channel epochs); server-written system lines ("X joined the chat") are English only; the inbox strings exist in English only (Arabic runs prove mirrored layout); captcha/proof-of-work hook for chat starts (P7); identity tokens expire (<= 5 min) before a lazily created session in a long-open page; no PII retention/erasure job; the phone connection banner is a compact variant only inside open conversations; `lang/ar.json` is partial.

## [0.3.0] - 2026-10-01 (phase-3)

Support categories, widgets, the embeddable loader and the builder. Developed in parallel with P2 and merged on `integrate/phase-2-3`.

### Added
- **Catalog and agents**: support categories (names per language, slug, order, active flag), staff management (create/edit/deactivate local agents, categories per agent, max concurrent chats), "My support categories" for agents. Agent categories are saved without range-locking the pivot table.
- **Widgets**: public key, draft vs published config (`config_version`), per-widget domain allow-list, greeting pool (weights, agent name/avatar, per locale), idle timeout (default 120 min) and queue timeout, take offline / back online, rotatable identity secret (HS256 JWT, `iss` = widget key, `jti`), builder with live preview (real loader in a mock host in three device frames, LTR/RTL, light/dark), embed-code tab (script, generic loader, iframe, REST).
- **Public delivery**: `/w/{key}.js` (boot config inlined, ETag), `/widget/v1/loader.js` (generic, reads `data-widget-key`), `/embed/{key}` (CSP `frame-ancestors` from the domain list), `GET /api/v1/public/widgets/{key}/config` and `/availability` behind `AuthorizeWidgetOrigin` (CORS echo for listed origins only, never cookies), per-widget and per-origin rate limits with CORS headers on 429.
- **Loader** (`resources/widget`, vanilla TypeScript, 15.65 KB gz of a 16 KB budget): Shadow-DOM launcher, greeting scheduler with the 3D flip to the agent face, dismiss policies, config precedence (`published < data-* < ChatFeatureSettings < runtime update`; policy fields are restrict-only), JS API and DOM events, versioned postMessage bridge with origin checks, handshake watchdog, full-screen panel on phones.
- Specs for the Phase 3 screens and the embeddable widget, proven together in real Chrome for the first time: `catalog/categories.spec.ts`, `catalog/agents.spec.ts` (+ a `@pizzasys` case: the Agents page when roles come from the Auth Portal), `widgets/widgets-list-and-builder.spec.ts` (every builder tab, hours validation, draft vs published, going live/offline, domains, identity secret, snippets, time zones), `widgets/preview.spec.ts` (the live preview runs the real loader in three device frames, live edits, static fallback), `widgets/loader-host.spec.ts` and `widgets/loader-origin.spec.ts` (the real widget on a customer-site page of another origin: shadow DOM, hostile host CSS, overrides, greetings and their dismiss policies, the handshake watchdog and the phone full-screen trap, the JS API, origin whitelist / CORS / CSP `frame-ancestors`, caching, no cookies), `widgets/loader-limits.spec.ts` (429 with CORS headers, unknown-key probing), `widgets/concurrency.spec.ts` (16 administrators configuring widgets in parallel), `widgets/escaping.spec.ts` (HTML in every administrator-typed value stays text), `widgets/views.spec.ts` (axe, 375px and Arabic/RTL for every new screen and the widget) and `screenshots/p3.spec.ts` (`docs/screenshots/p3/`, 25 screens x desktop/mobile x light/dark).
- New scenarios `p3-categories`, `p3-agents`, `p3-widgets`, `p3-host`, `p3-views`, `p3-views-rtl`, `p3-limits` (ports 8230-8239 and 8246; `seed: 'staff' | 'demo'` creates staff, categories and a demo widget), a static cross-origin "customer site" server (`e2e/support/host-server.mjs`, ports 8240-8245, started by `webServer`), an `api` / `adminApi` fixture for the management API, and `globalSetup` now builds `public/build` and the loader bundle itself when they are missing or older than the sources. See `docs/testing.md`.


### Changed
- `/w/<key>.js` now answers `403` (a console warning, no bubble, `Cache-Control: no-store`, `Vary: Referer`) to a page whose `Referer` is not on the widget's domain list or this installation's own origin. A request without a `Referer` is still served (the config is public; the chat iframe and every API call stay origin-checked). Before, an unlisted site still got the bubble and its greeting.
- Loader budget 15 KB -> 16 KB gz (boot-trust checks, per-origin handshake): the build is 15.65 KB. `.size-limit.json` and the loader build test follow.
- Domain list limit is 255 characters per entry everywhere (the client had 260); `resources/js/lib/limits.test.ts` reads the PHP rules so a drift fails a test.
- Replacing the domains, greetings or categories of a widget, and an agent's categories, now go through `App\Support\Database\DeadlockRetry`: up to 6 attempts with a short random, growing pause when MySQL aborts the transaction (1213/40001 or lock timeout 1205). Three immediate retries still lost 2 of 480 parallel saves.

### Fixed (found by the P3 e2e)
- Widget builder: a widget whose time zone was saved under a legacy name (`Asia/Calcutta`, `US/Pacific`; the settings accept them) could never save its draft again (`422 The timezone field must be a valid timezone`): `WidgetConfigValidator` validated the mirrored `hours.timezone` with `timezone:all` while `UpdateWidgetRequest` uses `all_with_bc`. Both accept the legacy names now.
- Domains tab: every scheme prefix was refused, although the server keeps `http://` (the admin's explicit permission for a site served without https) and drops `https://`; there was no way to allow such a site from the dashboard. The tab keeps `http://` and drops `https://` now (help text and error copy updated).
- Accessibility (axe best-practice): headings jumped from `h1` to `h3` on `/categories`, `/widgets` and every builder tab (section and row titles are `h2` now), and the builder had two `main` landmarks because the live preview's fake site (an `<iframe srcdoc>`) used `<main>` / `<header>`.

- `WidgetDeliveryTest::test_conditional_requests_and_etag_changes` failed when it ran in the half minute before 09:00 or 17:00 UTC on a weekday (the widget's availability flips at the default opening hours while `travel(30)` crosses the instant); the clock is pinned now.

### Known, not fixed
- The builder preview shows `Chat` as the panel's accessible name after the `title` text is emptied; the saved widget gets the server's English default `Support`.
- "Take widget offline ... right away" holds for the server; a browser or CDN that already has `/w/<key>.js` keeps using it for `max-age=60` + `stale-while-revalidate=300`.
- The launcher's own label text key (`launcherLabel`) is not part of the server's `WidgetTexts`; the loader clamps ranges more loosely than the server; category description/icon/colour are not forwarded to the chat panel yet (P4); the public-suffix list used for wildcard domains is partial; `SupportCategoriesPageController` is gated client-side only; `lang/ar.json` is partial.

### Notes
- Review: read-only reviewer passes over the backend, the loader and the dashboard, a dedicated front-end/back-end contract audit and a manual security pass; every finding was fixed (for example `useFlashToast` mounted twice). The `/security-review` and `/simplify` skills cannot run on this machine (they shell out to the blocked system git).

## [0.2.0] - 2026-10-01 (phase-2)

External sign-in through the pizzasys Auth Portal (setup mode 2). Developed in parallel with P3, reviewed and integrated together with it: `v0.2.0` and `v0.3.0` are tags on the same commit.

### Added
- **Setup wizard, mode 2**: portal environment (production and an optional testing one), service client name + token (encrypted), live `token-verify` probe, a verified portal administrator before finishing, role mapping (admin permission `chat.admin`, agent permission `chat.agent`, super roles default `super-admin`), optional NATS.
- **`PizzasysDriver`**: server-side login (the portal token never reaches the browser), `token-verify` on a 60 s cache with single-flight and a 15 s negative cache, circuit breaker, shadow users keyed by `(environment, sub)`, roles derived only from the portal (`PizzasysRoleResolver`), `EnsureSessionIsValid` revocation, degrade with a grace window then `503 auth_unavailable`, three login throttles (per email + address, per address, per email), best-effort upstream `logout` of the same token, `refresh-token` never called.
- **Environments**: `auth_environments` (production / testing), Settings > Auth (edit, connection test with a verdict that survives a reload, role mapping, active-environment switch that needs admin credentials on the target and signs everybody out), `chat:auth:switch-env` / `set-env` / `test` / `reactivate` / `prune-*` break-glass commands.
- **NATS consumer** `chat:auth:consume-nats`: durable consumer on `auth.v1.>`, stream ensured, de-duplicated on the envelope id, routing by CloudEvent `type`, dead-letter file, TLS verification, never trusts `user.updated.from`, never logs payloads. A NATS outage only lengthens the revocation lag to the verify TTL.
- `docs/pizzasys-findings.md`: empirical behaviour of a local clone (tokens never expire, bad user token = HTTP 200 `active:false`, bad service credential = 401, `refresh-token` revokes every token, `super-admin` carries no `chat.*` permission, `user.updated` leaks a hash); `docs/contracts/auth-pizzasys.md`.
- Specs for auth mode 2 against a real local pizzasys instance (the throwaway harness, started and stopped by `e2e/global-setup.ts`): the whole wizard in Auth Portal mode (`install/wizard-pizzasys.spec.ts`), sign-in/roles/revocation/role changes (`auth/login-pizzasys.spec.ts`), a portal outage with grace, 503 and recovery (`auth/portal-outage.spec.ts`, own `pizzasys-outage` project, runs last), Settings > Auth (`settings/auth-settings.spec.ts`), plus axe, 375px and RTL coverage of every mode-2 screen and `docs/screenshots/p2/` deck screenshots. New scenarios `fresh-pizzasys`, `installed-pizzasys`, `settings-pizzasys`, `wizard-views-pizzasys(-rtl)`, `installed-pizzasys-rtl`. The P1 wizard spec now asserts that the Auth Portal option is selectable. See `docs/testing.md`.


### Changed
- The sign-in page and the profile name the portal only when it is a public DNS name (`https://<host>`); a loopback/private portal (the local harness, a Docker service name) is never disclosed and never linked (`PortalLabel`). The e2e specs assert exactly that for the harness.
- Changing the portal address, service name or TLS verification (or the NATS address) requires re-entering the stored token (`SecretReentry`), and saving a connection change on the live environment first runs a connection test: a pair the portal refuses is not saved, so nobody is locked out. Display name, role mapping and NATS block edits keep the stored token.
- Setup-token takeover guard (loopback-only rule, per-session verification, throttling), SSRF guard on every outbound portal/NATS address (`OutboundUrlGuard`, `PORTAL_ALLOW_PRIVATE_HOSTS` for local development), `Http::preventStrayRequests()` in the shared test case.

### Fixed (found by the mode-2 e2e)
- A rejected Auth Portal form (wizard or Settings > Auth) flashed the typed service/NATS tokens into the session store as "old input"; they are excluded from flashing now (`bootstrap/app.php`).
- Inertia's local DevTools recorded the typed `service_token` / `nats_token` in clear text under `storage/inertia-devtools`; both keys are redacted now.
- Settings > Auth write endpoints answered 422 instead of 404 in mode 1 when the payload was invalid; the 404 comes first now.
- Auth Portal mode: Settings still linked to the Security page (a 404) and showed an editable profile form (saving answered 404) and "Delete account"; the Security link is gone and the profile is read-only with a pointer to the portal.

### Notes
- Verified against a local throwaway clone of the real pizzasys, not a production instance; the NATS consumer was first run against a real NATS server later (2026-10-01, see [Unreleased]). The public pizzasys repo's seeder creates a `super-admin` account with a known password: confirm it does not exist on the real instance.

## [0.1.0] - 2026-09-30 (phase-1)

Install gate, setup wizard, settings, mode-1 auth, role-aware shell, e2e suite.

### Added
- **Install domain**: file-backed `InstallState` (state + atomic `installed.lock`, 0600), `InstallGate` (web -> `/setup`, API -> 503 `not_installed`), `EnsureNotInstalled` (`/setup*` 404 forever; JSON callers get `{"status":"installed"}`), resumable flock-guarded `InstallRunner` with eight steps, fail-closed one-time `SETUP_TOKEN` guard (`hash_equals`, per-session, throttled), `InstallAwareConfigProvider` (session/cache/queue/broadcast forced to file/file/sync/null until installed). No database access before `migrate`.
- Commands: `chat:install` (non-interactive, `INSTALL_*` env), `chat:bootstrap-secrets` (APP_KEY, Reverb, VAPID, setup token), `chat:install:reset` (local only).
- **Settings** (typed registry, encrypted values, cached, 2 s per-process memo) and **audit log** with secret redaction; users get `role`, `is_admin`, `is_agent`, `is_active`, `auth_source`, ... (additive migration).
- **Auth layer**: `AuthDriver`/`RoleResolver` contracts, `AuthModeManager`, `FortifyDriver`, `LocalRoleResolver`, admin `Gate::before`, `EnsureSessionIsValid` / `EnsureChatAccess` (aliases `session.valid`, `chat.access` for API groups), registration gated by settings, staff API tokens scoped to `staff` with expiry and revocation on deactivation.
- **Frontend**: setup wizard (7 screens, resumable, Back), role-aware sidebar from the nav registry, `useTrans`/`useDirection`, RTL support, login variants (starter kit / Auth Portal), role-aware dashboard stub, generated Wayfinder routes and PHP-generated TS types for the wizard.
- `TRUSTED_PROXIES` (config `chat.trusted_proxies`) for running behind Caddy; `SANCTUM_EXPIRATION_MINUTES`.
- Contracts: setup wizard, auth driver, widget config, postMessage protocol, REST shapes, realtime events; `docs/pizzasys-findings.md` (empirical pizzasys behaviour).
### Added (e2e)
- Playwright e2e suite (`npm run e2e`, `e2e:headed`, `e2e:screenshots`): real Chrome, `desktop` and `mobile` (Pixel 7) projects, one throwaway Laravel server + `chatfeature_e2e*` database + private storage directory per scenario (`playwright.config.ts`, `e2e/`). Specs cover the install gate, the full setup wizard (environment check, validation, resume, Back, install, sign-in, 404 after the lock), the setup-token takeover guard (locked environment check, wrong/right token, per-session verification, throttling, token never in a response), sign-in/out, the role-aware shell (admin vs agent vs no access), settings, axe (WCAG 2.x A/AA, light + dark, every wizard screen), 375px layouts and Arabic/RTL. `E2E_SCREENSHOTS=1` writes full-page deck screenshots to `docs/screenshots/p1/` (desktop + mobile, light + dark). See `docs/testing.md`.

### Fixed (found by e2e)
- Setup wizard: "Check again" on the environment screen reached with Back threw the user forward to the server's step; only saved forms (non-GET visits) reset the client-side screen override now.
- Login: the dedicated "No chat access" notice never showed with the real backend (it looked for a `reason` prop / `access` error the backend did not send). The backend now flashes `reason=no_chat_access` for the rejected sign-in and for sessions ended by `EnsureChatAccess`, the login page passes it on, and the notice replaces the duplicate inline email error.
- Landmarks (axe): the auth/setup layouts (login, forgot password, the wizard) render their root as `<main>`; they had no main landmark.
- Contrast (axe, serious): `--destructive-foreground` (error copy) is red-700 in the light theme (4.2:1 on the tinted alert background before), and the "Delete account" warning box uses `text-red-700`.


### Fixed (code review)
- Staff are never gated on email verification; settings memo no longer stale in queue workers; undecryptable settings are reported; the wizard cannot take over an existing account; 404 is no longer read as "installed"; state file is created 0600; idle timeout range is 5-10080 minutes everywhere.

### Notes
- Gate: `composer ci:check` green (pint, PHPStan L7, 236 PHPUnit, `vp check`, `tsc`, 135 Vitest), 132 Playwright specs green, production build OK. `/code-review` (10 findings fixed) and a manual security pass; the `/security-review` and `/simplify` skills could not run because they shell out to the blocked system git.

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
