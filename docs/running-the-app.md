# Running PNE Chat: what is special

> Status: written at `v0.7.0`. For a production server see [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md); for operations after that, [runbook.md](runbook.md).

PNE Chat is a normal Laravel 13 + Inertia/React application, but it is **not one process**, and its **first run is a setup wizard, not `php artisan migrate`**. This page is the short list of things that behave differently from a stock Laravel app.

## 1. The processes

| Process | Dev command | Why it matters |
|---|---|---|
| Web, queue, Vite | `composer dev` (runs `php artisan dev`: `serve`, `queue:listen`, Vite and `pail` for logs) | The dashboard and the public API, plus a dev queue worker. |
| **Scheduler** | `php artisan schedule:work` (production: cron `* * * * * php artisan schedule:run`) | **Required, not optional.** Queue timeouts, the next routing wave, idle and unrated chat closing, presence sweeps, analytics rollups, retention, socket cut-off retries and WhatsApp replays are all scheduled commands. Without it chats never time out and agents stay "online" after closing the tab. |
| Queue worker | started by `composer dev`; production: `php artisan queue:work` | Needed unless `QUEUE_CONNECTION=sync`. Push notifications, mail, WhatsApp sends and webhooks run on it. |
| **Reverb** | `php artisan reverb:start` | The websocket server for realtime chat. Without it everything still works through REST polling (slower), and the dashboard tells you it is polling. |
| NATS consumer | `php artisan chat:auth:consume-nats --instance=main` | Only for auth mode 2 (pizzasys) with a NATS address saved in Settings > Auth. Optional: sessions are also re-checked against the portal on a short timer. |

`composer dev` does **not** start Reverb or the scheduler: run `php artisan reverb:start` and `php artisan schedule:work` in two more terminals (or use the "Smallest possible setup" below for a quick look).

## 2. First run: the setup wizard

1. Requirements: PHP 8.4 (`composer.json` allows `^8.3`), Composer, Node 24, MySQL 8+ (use a **dedicated, empty** database such as `chatfeature`), and Redis with the **phpredis** extension (see "Smallest possible setup" if you have none).
2. `composer setup` (installs, copies `.env`, generates the key, builds the frontend). Then **build the widget loader**, which is a separate bundle: `npm run build:widget`.
3. Generate the remaining secrets if `.env` lacks them: `php artisan chat:bootstrap-secrets` (idempotent: `APP_KEY`, Reverb keys, VAPID keys, a setup token).
4. Start the processes above and open <http://localhost:8000/setup>. With `APP_ENV=local` and a loopback request no setup token is needed; **in production the wizard refuses to start without the one-time `SETUP_TOKEN`**.
5. Pick the **auth mode**: mode 1 = the built-in sign-in (two-factor, passkeys), mode 2 = an external pizzasys portal where Admin/Agent come only from its roles. **The mode is locked once the wizard finishes.**
6. In the basics step set the **app URL to the final public origin** (for example `https://chat.example.com`). Widgets, embed snippets and the loader's `postMessage` origin come from this wizard setting, not from `APP_URL` and not from the request's Host header.
7. When it finishes, `/setup` answers 404 forever and `/` goes to the login page.

What is unusual here:

- **The wizard owns the first migration.** It expects a truly empty database. `composer setup` also runs `migrate`; to see the wizard on that database run `php artisan db:wipe --force` first (only on a database used by this app alone).
- **Nothing touches the database before the install.** Until `storage/app/installed.lock` exists the app forces `session=file`, `cache=file`, `queue=sync`, `broadcast=null`, so a fresh checkout boots with no MySQL or Redis. Pre-install one-off artisan commands that need the broadcaster can fail with `BROADCAST_CONNECTION=reverb` and no keys: run `chat:bootstrap-secrets`, or prefix the command with `BROADCAST_CONNECTION=null`.
- **Non-interactive install** (Docker, CI): put `INSTALL_ADMIN_EMAIL`, `INSTALL_ADMIN_PASSWORD`, `INSTALL_APP_URL`, ... in the environment and run `php artisan chat:install --mode=local` (or `--mode=pizzasys`). Remove the `INSTALL_*` variables afterwards. `php artisan chat:install:reset` wipes an install for development and works **only with `APP_ENV=local`**.
- **`installed.lock` is the authority** (plus a database flag). If you lose the `storage` directory in production you lose the lock and the wizard becomes reachable again: keep `storage` on a persistent volume and in your backups.

## 3. Realtime (Reverb) has four addresses

| Variable | Meaning |
|---|---|
| `REVERB_HOST` / `REVERB_PORT` / `REVERB_SCHEME` | The **public** address browsers connect to (behind a proxy: your domain, 443, `https`). |
| `REVERB_SERVER_HOST` / `REVERB_SERVER_PORT` | Where the Reverb process itself listens (in Docker `0.0.0.0`). |
| `REVERB_PUBLISH_HOST` / `PORT` / `SCHEME` | Where the **app** sends events to (in Docker the Reverb service name). |
| `REVERB_ALLOWED_ORIGINS` | Extra hosts allowed to open a websocket. `APP_URL`'s host is always allowed. **Never `*`.** |

The dashboard learns the Reverb address from the server at runtime (the `realtime` shared prop), so changing these needs no rebuild; `null` means "polling only". A Reverb outage never fails an HTTP request.

## 4. Things people trip over

- **TRUSTED_PROXIES.** Behind Caddy/nginx/Docker set it (address list, or `*` on a private compose network), otherwise rate limits, the audit log, secure cookies and generated URLs see the proxy instead of the visitor.
- **Redis and presence.** Who is online is stored in Redis (phpredis) with an automatic fallback to the database store. If your cache, queue or session driver is not Redis the database store is used. Redis must not evict keys (`noeviction`).
- **Reverb above about 1000 sockets needs `ext-uv`.** Without an event-loop extension Reverb tops out near 1013 connections and then exits with status 0 and no message. The production image installs it; on your own host install `ext-uv` or set `REVERB_APP_MAX_CONNECTIONS` to about 900. Raise the file-descriptor limit (`nofile 65536`).
- **The widget loader is built separately** (`npm run build:widget`, git-ignored output, 18 KB gzip budget checked by `npm run size`). Without it `/w/<key>.js` serves a "bundle not built" stub and the builder falls back to a static preview.
- **Web push** needs HTTPS (`localhost` counts) and the VAPID keys; the browser permission is asked on a click after an explainer, never on page load. Closing the dashboard tab is fine: push arrives through the service worker `public/sw.js`.
- **Mail** defaults to `MAIL_MAILER=log` (offline tickets are answered by e-mail, so configure SMTP for real use; Mailpit is available in `docker/compose.dev.yml`).
- **Content-Security-Policy** is `report-only` outside production and `enforce` in production (`CSP_MODE=enforce|report-only|off`). After a production deploy walk the browser checklist in [testing.md](testing.md) ("P7 hardening checks") once.
- **Sessions.** API calls only read the session; the dashboard calls `GET /session/keepalive` every 20 minutes. Keep `SESSION_LIFETIME` at 30 minutes or more.
- **WhatsApp (optional).** Needs the OpenWA gateway container ([whatsapp-openwa.md](whatsapp-openwa.md)): OpenWA must be able to call the app back (`app.url` reachable from the container, `SSRF_ALLOWED_HOSTS` on OpenWA), and an OpenWA on a loopback/private address needs `PORTAL_ALLOW_PRIVATE_HOSTS=true` in the app. Use a **dedicated phone number**: the unofficial engine carries an account-ban risk.
- **pizzasys mode.** Needs the portal URL and a service-client token (stored encrypted, never in `.env`). `pizzasys refresh-token` revokes all of a user's tokens everywhere, so the app never calls it by default.

## 5. Smallest possible setup (a quick look, no Redis, no websocket)

In `.env`: `SESSION_DRIVER=file`, `CACHE_STORE=file`, `QUEUE_CONNECTION=sync`, `BROADCAST_CONNECTION=null`. Then `composer dev` and open `/setup`. Chats work through REST polling and the database presence store; the scheduler is still needed for timeouts (`php artisan schedule:work`). Use Redis and Reverb for anything you want to feel like production.

## 6. Docker helpers (development only)

`docker/compose.dev.yml` is optional: `docker compose -f docker/compose.dev.yml up -d mailpit` (SMTP catcher), `--profile nats up -d` (NATS), `--profile whatsapp up -d` (OpenWA, loopback only), `--profile full up -d` (MySQL and Redis in containers). Docker Desktop must be running. The production stack is `compose.prod.yml` (see the deployment guide).

## 7. Tests and checks

```bash
composer test            # config:clear + pint --test + phpstan + phpunit (SQLite in memory; some groups are MySQL/Redis/NATS gated and skip)
composer ci:check        # everything: npm check, tsc, Vitest, the PHP gate
npm run e2e              # Playwright on real Chrome; needs MySQL, a built frontend (npm run build, npm run build:widget) and Chrome; ~35 minutes
composer docs:api        # regenerate docs/api/openapi-*.yaml after changing an API route (a test fails when they are stale)
```

Tests never reach a network (`Http::preventStrayRequests()`): every outbound call in a test needs `Http::fake`. The end-to-end suite owns ports 8110-8409 and the `chatfeature_e2e*` databases; start nothing else there.

## 8. Notes specific to the author's Mac

- The system `git` is blocked (Xcode licence): use `/opt/homebrew/bin/git`, and do **not** put `/opt/homebrew/bin` first on `PATH` (it would switch PHP to Homebrew's 8.5 instead of the Herd-lite 8.4 the project targets).
- The repository lives on the external `Rag` volume; if it disconnects mid-session the working directory looks deleted: check `/Volumes` first.
- `.npmrc` has `ignore-scripts=true`.

## 9. Quick troubleshooting

| Symptom | Check |
|---|---|
| `/setup` shows "token required" | Production needs `SETUP_TOKEN` (see `docker compose logs app` or `chat:bootstrap-secrets`). |
| `/setup` answers 404 | The install is done (`storage/app/installed.lock` exists). |
| Every artisan command crashes before install | `BROADCAST_CONNECTION=reverb` without Reverb keys: run `php artisan chat:bootstrap-secrets` or use `BROADCAST_CONNECTION=null`. |
| Chats never time out, agents stay online | The scheduler is not running. |
| Dashboard says "Connecting to live updates" for good, or the log is full of `Pusher error: <!DOCTYPE HTML ...` | Reverb is not running, or something else owns its port (**Homebrew Apache `httpd` listens on 8080** on many Macs): check `lsof -nP -iTCP:8080 -sTCP:LISTEN`. Set `REVERB_PORT` **and** `REVERB_SERVER_PORT` to a free port (for example 8081), restart `php artisan reverb:start`, and rebuild or restart Vite (the browser reads the address from the server, but `VITE_REVERB_*` follow `REVERB_PORT`). The inbox keeps working by polling meanwhile. |
| Widget does not appear | `npm run build:widget` was not run, the widget is switched off (Widgets > the switch, "Take widget live"), or the host page's origin is not in the widget's **Domains** tab (type it, press Add **and click Save changes**; for a local page use `localhost:PORT`). |
| The bubble appears but its chat window is empty | The page's origin is not in the widget's domain list (the browser refuses to frame the panel: `frame-ancestors`), or the widget was edited but not saved. Open the widget's Embed tab: it now says what is missing. |
| Visitors always get "No agent is available" although you are online | You are online but serve no category: Settings > Support categories (the dashboard now says so). |
| Client IPs are all the proxy's | `TRUSTED_PROXIES` is not set. |
| Push notifications never arrive | VAPID keys missing, page not on HTTPS, or the browser permission was denied. |
