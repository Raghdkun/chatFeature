# Deploying on a server that already has Docker, nginx and certbot

> Status: written 2026-10-06. The setup was run end to end on a laptop with an nginx container standing in for the server's nginx (section 11 lists exactly what was and was not proven). It has **not** been run on your VPS yet. For a bare server where nothing owns ports 80/443, the Caddy-with-its-own-certificates guide is [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md); everything it says about sizing, `.env`, the wizard, backups and upgrades applies here too and is not repeated.

## 1. What this setup is

```text
 visitors / agents                     your server
 ─────────────────  https (443)  ┌────────────────────────────────────────────────────────────────────────┐
   browser, widget ───────────────▶ nginx (host, certbot)                                                  │
                                  │   TLS, redirect http→https, client_max_body_size, websocket upgrade     │
                                  │        │ http://127.0.0.1:8088   (loopback only, never public)          │
                                  │        ▼                                                                │
                                  │  ┌─────────────── Docker (compose.prod.yml + compose.nginx.yml) ──────┐ │
                                  │  │ web (Caddy, plain HTTP)  static files ─┐                           │ │
                                  │  │        │                  /app/*  ─▶ reverb :8080 (websocket)       │ │
                                  │  │        └ everything else ─▶ app (php-fpm, unix socket)             │ │
                                  │  │ queue · scheduler · nats-consumer · mysql 8.4 · redis 7 (internal)  │ │
                                  │  └────────────────────────────────────────────────────────────────────┘ │
                                  └────────────────────────────────────────────────────────────────────────┘
```

- **nginx and certbot are yours**: they own ports 80 and 443 and the certificates, exactly as for your other sites.
- **Caddy stays, but only as an internal router** (`web` service): it serves the built static files, hands pages to php-fpm and `/app/*` to Reverb. It listens on plain HTTP on **127.0.0.1:8088** and gets no certificates. Keeping it means nginx needs a ten-line proxy instead of a FastCGI setup, and the routing rules are the very ones the stock stack uses (`docker/caddy/routes.caddy`, shared by both modes).
- Nothing else is published: MySQL, Redis, Reverb, OpenWA and NATS have no `ports:`.

Files that make this mode (all in the repository):

| File | What it is |
|---|---|
| `compose.nginx.yml` | an override of `compose.prod.yml`: switches the stock `caddy` edge off, adds the `web` service published on 127.0.0.1 |
| `docker/caddy/Caddyfile.proxy` + `routes.caddy` | Caddy without TLS, trusting the headers nginx sends |
| `docker/nginx/pne-chat.conf` | the nginx site to install (certbot completes it) |
| `scripts/init-env.sh --nginx` | prepares `.env` for this mode |

## 2. Before you start: look at the server

Run these on the VPS and read the answers, because a shared server has surprises a fresh one does not.

```bash
docker compose version            # must be v2.24 or newer (the stack uses `env_file: required: false`)
nginx -v && sudo nginx -T 2>/dev/null | grep -nE "include .*(sites-enabled|conf.d)|server_tokens|connection_upgrade"
certbot --version
sudo ss -ltnp | grep -E ':(80|443|8088)\b'         # nginx on 80/443; NOTHING on 8088 (pick another port with --proxy-port if it is taken)
free -m && df -h /var/lib/docker                   # the stack wants about 3-4 GB of RAM when busy (sizing: deployment-hostinger-kvm.md section 2) and ~5 GB of disk
sudo ufw status                                    # 80/443 open (e.g. `ufw allow 'Nginx Full'`); 8088 must NOT be opened
dig +short chat.example.com                        # the A (and AAAA) record of your domain: it must already point at THIS server
```

Things to decide or check:

- **The domain** (`chat.example.com` below): one host name for the whole product. Dashboard, widget loader, visitor panel, API and websocket all live on it.
- **Other sites on the same nginx** are not touched. Our site file defines a `map` called `$pne_connection_upgrade` and an `upstream` called `pne_chat`; the names are unique on purpose, so they cannot collide with an existing `$connection_upgrade`.
- **Docker and `ufw`**: Docker publishes ports around `ufw`. That is why this stack publishes exactly one port and binds it to `127.0.0.1`. Never change that binding.
- **Another reverse proxy in front of nginx** (Cloudflare, a load balancer)? Read section 9 first.

## 3. Get the code onto the server

Section 6 of the other guide has three ways (git remote, `git archive` over SSH, `git bundle`). The shortest, from your laptop in the repository:

```bash
ssh deploy@<server> 'sudo mkdir -p /opt/pnechat && sudo chown deploy:deploy /opt/pnechat'
git archive --format=tar HEAD | ssh deploy@<server> 'tar -x -C /opt/pnechat'
```

`ls /opt/pnechat` must show `Dockerfile`, `compose.prod.yml`, **`compose.nginx.yml`**, `docker/nginx/` and `scripts/`.

## 4. Configure and build

```bash
cd /opt/pnechat
scripts/init-env.sh --domain chat.example.com --email you@example.com --nginx          # add --proxy-port 8090 if 8088 is taken
```

That creates `.env` (mode 600) from `.env.production.example` and, because of `--nginx`, sets:

| Line | Value | Why |
|---|---|---|
| `COMPOSE_FILE` | `compose.prod.yml:compose.nginx.yml` | plain `docker compose ...` then always includes the override |
| `PROXY_PORT` | `8088` | the loopback port of the `web` container; the nginx site must point at the same number |
| `TRUSTED_PROXIES` | `*` | the application believes `X-Forwarded-For` / `-Proto`; safe **only** because the port is on 127.0.0.1 and nginx overwrites those headers (section 9) |
| `CADDY_TLS` | `internal` | not used here; `compose.prod.yml` just insists on a value |
| `APP_DOMAIN`, `APP_URL`, `REVERB_HOST` | your domain / `https://` + domain | the public address; `REVERB_PORT=443`, `REVERB_SCHEME=https` stay |

Then build the image and let it make the secrets only PHP can make (APP_KEY, Reverb keys, VAPID keys, the one-time setup token):

```bash
docker compose build                       # about 5-8 minutes the first time (PHP extensions, composer, the frontend build)
scripts/init-env.sh --secrets
nano .env                                  # mail settings (SMTP), memory limits, CSP_MODE: see the sections of the other guide below
```

The rest of `.env` is the same as in [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md) section 7 and the variable reference in its appendix 14.1. **Keep a copy of `.env` in your password manager** (without `APP_KEY` the encrypted settings in the database cannot be read).

## 5. Start the stack

```bash
docker compose up -d
docker compose ps
```

Expected: eight services, all `healthy` after a minute (`app`, `web`, `mysql`, `redis`, `queue`, `scheduler`, `reverb`, `nats-consumer`; there is **no** `caddy`). `queue`, `scheduler`, `reverb` and `nats-consumer` print "waiting for the setup wizard" until section 7: that is normal.

```bash
curl -sI http://127.0.0.1:8088/up | head -1             # HTTP/1.1 200 OK    (the web container, straight)
sudo ss -ltnp | grep -E ':8088\b'                       # 127.0.0.1:8088 only. If it says 0.0.0.0 or *, stop and fix compose.nginx.yml
```

> In this mode always start the stack with plain `docker compose ...` (it reads `COMPOSE_FILE` from `.env`), or with both `-f` files. `docker compose -f compose.prod.yml up` alone brings the stock `caddy` back, which wants ports 80/443 (nginx has them).

## 6. The nginx site and the certificate

```bash
cd /opt/pnechat
sudo cp docker/nginx/pne-chat.conf /etc/nginx/sites-available/chat.example.com.conf
sudo sed -i 's/chat\.example\.com/YOUR.DOMAIN/g; s/127\.0\.0\.1:8088/127.0.0.1:YOUR_PROXY_PORT/' /etc/nginx/sites-available/chat.example.com.conf
sudo ln -s /etc/nginx/sites-available/chat.example.com.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

(No `sites-available`/`sites-enabled` on your distribution? Put the file in `/etc/nginx/conf.d/chat.example.com.conf`.)

At this point `http://YOUR.DOMAIN/login` already works, over plain HTTP. Now the certificate, with the plugin you already use:

```bash
sudo certbot --nginx -d YOUR.DOMAIN --redirect
sudo certbot renew --dry-run                     # renewal works through the same plugin; nothing to add to cron
```

certbot edits the server block in place: it adds `listen 443 ssl`, the certificate lines and an http→https redirect. The proxy settings, which are the part that matters, are inside the same block and therefore apply to https as they are. certbot does not turn on HTTP/2 by itself: until you do, check 1 below answers `HTTP/1.1 200` and everything works. On nginx 1.25.1 or newer add `http2 on;` inside the block; on older nginx (Ubuntu 24.04 ships 1.24) put `http2` on the TLS listen lines instead: `sudo sed -i -E 's/^(\s*listen .*443 ssl)/\1 http2/' /etc/nginx/sites-available/YOUR.DOMAIN.conf && sudo nginx -t && sudo systemctl reload nginx`.

What the site file does, so you can maintain it:

- `location /app/` is the websocket (Reverb): HTTP/1.1, `Upgrade`/`Connection` forwarded, `proxy_read_timeout 3600s`, no buffering.
- `location /` is everything else, with `X-Forwarded-For` **replaced** by the address nginx saw, `X-Forwarded-Proto`, `X-Forwarded-Host`.
- `client_max_body_size 30m` matches Caddy's cap; the settings allow chat images up to 25 MiB.
- **`proxy_buffer_size 32k` and friends are not optional.** A dashboard page sends about 8 KB of response headers (the `Link: ...; rel=preload` header listing the page's scripts and fonts is ~5 KB on its own). nginx's default buffer is 4 or 8 KB: without these lines every dashboard page is a `502 Bad Gateway` and the error log says `upstream sent too big header while reading response header from upstream`. (That is exactly what the local test hit first.)

## 7. First run: the setup wizard

Open `https://YOUR.DOMAIN/setup`. Follow section 8.2 of [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md): the setup token is the `SETUP_TOKEN=` line of `.env`, the **Application URL must be `https://YOUR.DOMAIN`** (no port, no trailing path or slash), and afterwards you empty `SETUP_TOKEN`, add `APP_INSTALLED=true` and `docker compose up -d`. The four workers notice the finished install within five seconds. The command-line installation (`chat:install`) in that section works unchanged.

## 8. Verify it

| # | Check | Command | Expect |
|---|---|---|---|
| 1 | Application answers over TLS | `curl -sI https://YOUR.DOMAIN/up` | `200` (`HTTP/2 200` once HTTP/2 is on, see section 6) |
| 2 | Plain HTTP redirects | `curl -sI http://YOUR.DOMAIN/login` | `301` to `https://...` |
| 3 | Headers survived the proxy | `curl -sI https://YOUR.DOMAIN/login` | `strict-transport-security: max-age=31536000` (proves the app sees `https`), `content-security-policy...` with a `nonce-`, `x-frame-options: SAMEORIGIN`, `x-content-type-options: nosniff` |
| 4 | Static files are cached | `curl -sI https://YOUR.DOMAIN/widget/v1/loader.js` | `200`, `cache-control: public, max-age=300` |
| 5 | Things that must not be reachable | `for p in /.env /apps/x /storage/x /x.php; do curl -s -o /dev/null -w "$p %{http_code}\n" https://YOUR.DOMAIN$p; done` | four `404`s (`/apps/*` is Reverb's publish API, never exposed) |
| 6 | **Websocket** end to end | see below | `HTTP/1.1 101 Switching Protocols` and a `pusher:connection_established` frame |
| 7 | A foreign website cannot open a websocket | same with `-H "Origin: https://evil.example"` | after the 101 the frame is `pusher:error ... "Origin not allowed"` |
| 8 | The application sees the REAL visitor address | sign in, change a category, then `docker compose exec mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" "$MYSQL_DATABASE" -e "select action, ip_address from audit_logs order by id desc limit 3"'` | **your** public address, not `172.x` |
| 9 | The dashboard says it is live | open the inbox in a browser | no "polling only" banner; DevTools network tab shows a `101` websocket to `/app/...` |
| 10 | A visitor can chat | open a page with the widget snippet (Widgets → your widget → Embed) | the bubble, a chat that reaches an online agent |

Check 6, with your Reverb key (`grep ^REVERB_APP_KEY= .env`):

```bash
curl -sik --http1.1 --max-time 4 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Origin: https://YOUR.DOMAIN" "https://YOUR.DOMAIN/app/<REVERB_APP_KEY>?protocol=7&client=js&version=8.0.0&flash=false" | head -12
```

## 9. Operating it

Commands, upgrades, backups, restore drills, secret rotation and break-glass are the ones of [deployment-hostinger-kvm.md](deployment-hostinger-kvm.md) section 11, with these differences:

- **Plain `docker compose`** in `/opt/pnechat` (it reads `COMPOSE_FILE` from `.env`). `scripts/backup.sh` and `scripts/restore.sh` read it from `.env` as well, so a restore stops and restarts `web` (not a `caddy` that does not exist here).
- **Upgrade**: unpack the new release over the directory, `docker compose build`, `docker compose run --rm app php artisan migrate --force`, `docker compose up -d`. Only if `docker/nginx/pne-chat.conf` itself changed in the release (see the changelog) re-apply it to the server's copy, then `sudo nginx -t && sudo systemctl reload nginx`.
- **Logs**: the application's in `docker compose logs -f app queue reverb`; Caddy's access log (one JSON line per request, secrets redacted) in `docker compose logs web`; nginx's in `/var/log/nginx/`.
- **Certificates** renew through certbot's timer; nothing in the stack holds a certificate.

**Why the port must stay on 127.0.0.1.** `TRUSTED_PROXIES=*` makes the application believe `X-Forwarded-For` and `X-Forwarded-Proto`. If the `web` container were reachable from the internet, anybody could send those headers: spoof their address (and sidestep every per-address rate limit and the sign-in lockout) or pretend to be on https. With the loopback binding the only sender is the nginx on this machine, and that nginx **overwrites** the headers (`proxy_set_header X-Forwarded-For $remote_addr`) instead of passing a visitor's through.

**Another proxy or a CDN in front of nginx (Cloudflare, a load balancer).** Then `$remote_addr` in nginx is that proxy's address and every visitor looks the same. Tell nginx whom to believe, once, in the `http` block, for example for Cloudflare: `set_real_ip_from <each Cloudflare range>; real_ip_header CF-Connecting-IP;` (the list is at cloudflare.com/ips). `TRUSTED_PROXIES=*` stays as it is: it concerns the hop between nginx and the stack.

## 10. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `502 Bad Gateway` on dashboard pages, `/up` works | the buffer lines are missing from the site (error log: `upstream sent too big header`). Re-copy `docker/nginx/pne-chat.conf` |
| `502` on everything | the stack is down or `PROXY_PORT` and the nginx `server 127.0.0.1:...;` line differ: `docker compose ps`, `curl -sI http://127.0.0.1:8088/up` |
| `504` after about 70 s on a page | php-fpm is overloaded or a job hangs: `docker compose logs app`; nginx waits 75 s, Caddy 70 s |
| Dashboard shows "reconnecting / polling only" | the websocket fails. Check 6 above. Usual causes: the `/app/` block lost its `Upgrade`/`Connection` lines; `REVERB_HOST`, `REVERB_PORT=443`, `REVERB_SCHEME=https` do not match the public address (`.env`, then `docker compose up -d`); `reverb` not healthy (it waits for the wizard to finish) |
| Redirect loop, `http://` links or "mixed content", session cookie not kept | the application does not see `https`: `TRUSTED_PROXIES` is empty (set `*`), or the site does not send `X-Forwarded-Proto`, or `APP_URL` is `http://` |
| `413 Request Entity Too Large` when sending an image | `client_max_body_size` is smaller than 30m somewhere (another `http`-level value, or not copied) |
| Everybody has the same IP in the audit log, the lockout hits everyone | `TRUSTED_PROXIES` is empty, or a CDN sits in front (section 9) |
| `Bind for 0.0.0.0:80 failed: port is already allocated` | someone started the stack with `-f compose.prod.yml` only and the stock `caddy` came back: `docker compose down`, then `docker compose up -d` |
| `nginx -t`: `duplicate "map"`/`"upstream"` | the site file was copied twice; keep one copy |
| certbot: "could not find a matching server block" | the file is not enabled or its `server_name` is not your domain |
| WhatsApp (OpenWA) webhooks do not arrive | OpenWA is inside Docker and calls `https://YOUR.DOMAIN/webhooks/...` through the server's public address; the server must be able to reach its own public IP (most VPS can). See `docs/whatsapp-openwa.md`; `PORTAL_ALLOW_PRIVATE_HOSTS=true` is needed for the gateway's private address |

## 11. What was and was not verified

Run on 2026-10-06 on a Mac with Docker Desktop, with the Docker daemon only for these tests, a stock `nginx:alpine` container with a self-signed certificate on port 443 standing in for the host's nginx (the site file as shipped plus the TLS lines certbot adds), the images built from this commit:

- **Verified**: both Caddyfiles validate with Caddy itself; `docker compose config` for both modes (the merged file has no `caddy`, `web` is bound to `127.0.0.1`); the stack starts healthy; the nginx syntax test passes for the file as shipped and as certbot completes it; a sign-in through the proxy (session and CSRF cookies `Secure`, redirect to the https dashboard, API call with the session); `Strict-Transport-Security` and https `Link` preload URLs (the application saw `https`); static caching headers; `/.env`, `/apps/*`, `/storage/*`, stray `.php` answer 404; a visitor-sent `X-Forwarded-For`/`-Proto` is overwritten by nginx; the application stored the address nginx saw (not the Docker bridge address) for an audited action; a websocket handshake through nginx and Caddy to Reverb (101 and `connection_established`), and a foreign `Origin` refused with `Origin not allowed`; `scripts/backup.sh` and `scripts/restore.sh` in this mode; the stock Caddy-with-TLS mode still works after the Caddyfile split.
- **Found and fixed by that test**: the `caddy` binary needs `NET_BIND_SERVICE` even with `cap_drop: ALL` (without it the container loops on `exec caddy failed: Operation not permitted`); nginx needs bigger proxy header buffers (section 6).
- **Not verified**: a real server, a real Let's Encrypt certificate through `certbot --nginx`, certificate renewal, `ufw` rules, your nginx version's quirks, real client addresses (the test saw the Docker bridge address because everything ran on one machine), WhatsApp through the host's public address, behaviour under load behind this proxy (the 1 000-socket test of [runbook.md](runbook.md) was run against Caddy directly).
