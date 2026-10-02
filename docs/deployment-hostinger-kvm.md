# Deploying PNE Chat on a Hostinger KVM VPS

> Status: written and run in P8 (track 8A). The Docker image, `compose.prod.yml`, the Caddyfile and the backup scripts were **built and run on a development Mac (Docker Desktop, Apple silicon, arm64)** with the host ports 18080 / 18443, `tls internal` and a throwaway `.env`: first run through the real setup endpoints, a visitor chat reaching an agent over `wss://` through Caddy, the scheduler, the queue worker, restarts, `down`/`up`, `migrate --force`, an encrypted backup, **destroying every volume and restoring**, 2 500 websockets through Caddy. Section "What was and was not verified" (14.5) lists exactly what that covers. **Not verified: real Let's Encrypt issuance, a real Hostinger VPS or hPanel, an amd64 server, a real WhatsApp phone, a real pizzasys portal.** Every statement about Hostinger's panel is marked *(as of writing, verify in hPanel)*: names, menus and limits change.

If you have never used Docker: read sections 1 to 8 in order, copy the commands, and keep section 13 (troubleshooting) open. Every command is meant to be pasted as it is, after replacing `chat.example.com` and `you@example.com`.

## Contents

1. [What you get](#1-what-you-get)
2. [Sizing](#2-sizing)
3. [Hostinger side](#3-hostinger-side)
4. [Server hardening](#4-server-hardening)
5. [Install Docker](#5-install-docker)
6. [Get the code onto the server](#6-get-the-code-onto-the-server)
7. [Configure `.env`](#7-configure-env)
8. [Build, start, first run](#8-build-start-first-run) (setup wizard, WhatsApp, NATS)
9. [Verification checklist](#9-verification-checklist)
10. [E-mail](#10-e-mail-smtp)
11. [Operations](#11-operations) (logs, upgrade, backups, restore drill, monitoring, secrets, break-glass)
12. [Security checklist](#12-security-checklist)
13. [Troubleshooting](#13-troubleshooting)
14. [Appendix](#14-appendix) (variables, ports, volumes, commands, what was verified)

---

## 1. What you get

One server, one `docker compose` project, **two public ports** (80 and 443) and nothing else reachable from the internet.

```text
                          Internet
                 80/tcp  443/tcp  443/udp (HTTP/3)
                             |
                     +-------v--------+
                     |     caddy      |  automatic HTTPS (Let's Encrypt), HTTP->HTTPS, gzip/zstd,
                     |  (web image)   |  /build /widget/v1/loader.js /sw.js ... served from its OWN copy of public/
                     +---+--------+---+
        php-fpm socket   |        |  wss://<domain>/app/<key>
        (volume)         |        |
                  +------v--+  +--v-------+         edge network   : caddy only (the published side)
                  |   app   |  | reverb   |:8080    internal network: everything below talks here (no ports published)
                  | php-fpm |  | websocket|         whatsapp network: caddy (alias of your domain), app, queue, scheduler, openwa
                  +----+----+  +----^-----+
                       |            | publish API (/apps/*, never proxied)
   queue  scheduler  nats-consumer  |   (same image as `app`, different command)
        \     |      /             /
         +----v-----v-------------+
         |  mysql 8.4  | redis 7  |        openwa (optional profile `whatsapp`)    nats (optional profile `nats`)
         +-------------+----------+
```

| Service | Image / target | What it does | Published | Volumes | Idle RAM measured |
|---|---|---|---|---|---|
| `caddy` | `web` target of the `Dockerfile` (Caddy 2 + the `public/` of the same build) | TLS, redirects, static files, `wss` proxy, access log (JSON) | **80, 443/tcp, 443/udp** | `caddy-data` (certificates), `caddy-config`, `fpm-socket` | 21 MB; about 170 KB per open websocket |
| `app` | `app` target (PHP 8.4-FPM, Debian bookworm, non-root) | Pages, REST API, widget scripts, webhooks | none (unix socket) | `storage`, `fpm-socket` | 60 MB + workers |
| `queue` | same image | `php artisan queue:work`: broadcasts, push, mail, WhatsApp jobs | none | `storage` | 46 MB |
| `scheduler` | same image | `php artisan schedule:work`: **required**, runs every timer of the product | none | `storage` | 46 MB |
| `reverb` | same image (`ext-uv`, `nofile` 65 536) | Laravel Reverb websocket server on :8080 | none | `storage` | 48 MB; 110-125 MB at 1 500-2 500 sockets |
| `nats-consumer` | same image | `chat:auth:consume-nats`: pizzasys user/role events (idle in mode 1) | none | `storage` | 46 MB |
| `mysql` | `mysql:8.4` | The database (utf8mb4, UTC, tuned `docker/mysql/my.cnf`) | none | `mysql-data` | 215 MB |
| `redis` | `redis:7-alpine` | Cache, queue, sessions, agent presence (AOF every second, `noeviction`, password) | none | `redis-data` | 11 MB |
| `openwa` | OpenWA 0.23.7, pinned by digest (profile `whatsapp`) | WhatsApp gateway | none | `openwa-data` (**the WhatsApp login**) | 150 MB idle, 550-800 MB with a session |
| `nats` | `nats:2.11-alpine` (profile `nats`) | Optional JetStream server | none | `nats-data` | 8 MB |

Why these choices (all measured or read from the code, not guessed):

- **One application image for five services.** `queue`, `scheduler`, `reverb` and `nats-consumer` only differ by command, so there is one thing to build, scan and roll back.
- **Caddy has its own copy of `public/`.** `/build/*` (hashed bundles), `/widget/v1/loader.js`, `/sw.js` and the icons come from the image that was built from the same code as `app`: there is no volume of shared public files that can go out of sync during an upgrade.
- **php-fpm listens on a unix socket**, not a TCP port. FastCGI has no authentication; with a TCP port every container on a shared network (OpenWA runs a browser engine) could run PHP. The socket lives in a volume only `app` and `caddy` mount.
- **Workers wait for the installation.** Until the setup wizard has written `installed.lock` the application forces file/sync/null drivers and does not know its saved URL yet. `queue`, `scheduler`, `reverb` and `nats-consumer` therefore **wait** (and report healthy) and start by themselves a few seconds after the wizard finishes. Nothing in the stack ever runs a migration or an installation on its own.
- **`nats-consumer` is always on.** It idles (45 MB, no CPU) until a NATS address is saved in Settings > Auth, so choosing mode 2 later, or adding NATS, needs no compose change. A profile would be one more thing to forget; in mode 1 you can `docker compose stop nats-consumer`.
- **Hardening:** every application container is non-root (`www-data`), has a **read-only root file system** (writable: `storage` volume, `/tmp` and `bootstrap/cache` as tmpfs), `cap_drop: ALL`, `no-new-privileges`, an `init` process, a health check, `restart: unless-stopped` and rotated JSON logs (10 MB x 5 per service). MySQL, Redis, Reverb, OpenWA and NATS are not published.

### What the `storage` volume holds, and what happens if it is lost

`storage` holds `app/installed.lock` and `install-state.json` (the install gate), the **chat attachments** (`app/private/chat/attachments`) and the WhatsApp media. It must persist: back it up (section 11.3).

- **Lost `storage`, database intact:** attachments are gone (images show as broken), and the application thinks it is not installed, so `/setup` opens again (still guarded by `SETUP_TOKEN`) and the workers wait. Recovery without a backup: keep `SETUP_TOKEN` in `.env`, open `/setup` and click through the wizard: its migration step notices that the database already says "installed" and **restores the lock** ("This database is already installed; the install lock was restored."; verified: nothing else is re-created, no second administrator). Better, restore the backup (section 11.4) or set `APP_INSTALLED=true` in `.env` after the first installation so a lost volume can never reopen `/setup`.
- **Lost database, `storage` intact:** the lock says installed but there are no tables: restore the database dump (11.4). Without any dump the instance is empty and must be installed again (`docker compose down -v` and start over).

---

## 2. Sizing

Hostinger's current plan names, prices and specifications **must be checked in hPanel** *(as of writing, verify in hPanel)*; they change. Choose by the specification (vCPU, RAM, disk), not by name. The measurements below are from one 10-core Mac running Docker Desktop (arm64), so read them as relative numbers.

**What is CPU-bound, what is RAM-bound**

| Part | Bound by | Notes |
|---|---|---|
| php-fpm (`app`) | CPU, then RAM | One request per worker; every chat message, rate limiter and page is PHP. About 40-60 MB per busy worker (`FPM_MAX_CHILDREN`, default 16). |
| MySQL | RAM (buffer pool), disk I/O | `innodb_buffer_pool_size` is 512 MB in `docker/mysql/my.cnf`; raise it on bigger servers. History search is FULLTEXT. |
| Reverb | file descriptors and a little RAM; CPU almost idle | 1 513 open descriptors at 1 500 sockets, 110-125 MB RSS for 1 500-2 500 sockets. P7 measured 18-23 % of one core at 1 020 sockets and 17 messages a second. |
| Caddy | RAM per websocket | About 170 KB per open websocket (about 380 MB at 2 500, held down by `GOMEMLIMIT`). |
| OpenWA | RAM, CPU spikes | 150-180 MB idle, **550-800 MB for the first running session**, about 400 MB for each further one; a session start burns a core for 6-25 s. |
| `docker compose build` | RAM and CPU, once per release | Needs about 2 GB free RAM; on a 4 GB server add swap (section 4). |

**Three profiles** (the OS and Docker themselves take about 0.5 GB):

| | A. Chat only | B. Chat + WhatsApp (N numbers) | C. Bigger team, about 1 000 visitor sockets or more |
|---|---|---|---|
| For | up to about 10 agents, a few hundred open visitor sockets | the same, plus N paired WhatsApp numbers | 20+ agents, 1 000+ concurrent visitors |
| vCPU | 2 | 2 (4 for more than 3 numbers) | 4 or more |
| RAM | **4 GB** (+2 GB swap) | **8 GB** for up to about 6 numbers: 1.0 GB stack + 1.0 GB first number + 0.4 GB per further number + OS | **8-16 GB** |
| Disk | 40 GB | 60 GB (OpenWA's image alone is 2.2 GB) | 80 GB+ |
| Tuning | defaults | `OPENWA_MEM_LIMIT` 1.5 GB + 0.4 GB per extra number | `FPM_MAX_CHILDREN=32`, `innodb_buffer_pool_size` 2-4 GB (edit `docker/mysql/my.cnf`), `docker compose up -d --scale queue=2`, `MYSQL_MEM_LIMIT`/`APP_MEM_LIMIT` up |

Honest limits of these numbers: the sockets were bare websockets (no chat traffic) held through Caddy; the end-to-end chat path was run with one agent and one visitor. The repository's load test (`scripts/loadtest-realtime.mjs`) provisions through the database and cannot target the compose stack, so **chat throughput of the php-fpm stack was not measured** (the P7 laptop run, [runbook.md](runbook.md) "Load-test results", saturated at about 40 sends a second with the PHP dev server and `QUEUE_CONNECTION=sync`; a php-fpm + Redis + queue-worker stack has more headroom, by how much is unknown).

**Disk.** Images: about 0.5 GB (app 420 MB, web 90 MB) plus OpenWA 2.2 GB. The build cache grows over releases (`docker builder prune` reclaims it). MySQL grows with chats (small: text); attachments are re-encoded images, 5 MiB each by default and at most 30 MiB per conversation. Logs are capped (10 MB x 5 per service). Backups need (dump + `storage`) x retention: keep them on another machine too (section 11.3).

---

## 3. Hostinger side

Everything in this section describes hPanel and Hostinger's offer *as of writing*; menus move. If a step does not match what you see, the intent is what counts.

1. **Order a VPS** with the specification from section 2 (a "KVM" virtual server, KVM meaning a real virtual machine you control, not a shared container). Pick the data-centre location closest to your visitors.
2. **Operating system template:** choose a plain **Ubuntu 24.04 LTS**. If the template list also offers "Ubuntu 24.04 with Docker", it works too: this guide installs Docker itself, so after the first login check `docker compose version` and skip section 5 if it prints v2.24 or newer (this guide was run with v5.5.1).
3. **Root password / SSH key:** add your **SSH public key** in the order or later in hPanel *(as of writing, a section called "SSH keys" or the VPS "Settings")*. Without a key set a long random root password in your password manager; section 4 turns passwords off.
4. **First access:** use the SSH command hPanel shows (`ssh root@<server IP>`) or hPanel's **browser terminal** *(as of writing, a "Browser terminal" button on the VPS overview)*; the browser terminal is the way back in if you lock yourself out over SSH.
5. **hPanel firewall** *(as of writing, a firewall in the VPS "Security" section)*: it filters traffic **outside** the server, so it also covers Docker's published ports (see the `ufw` caveat in section 4). Allow: `22/tcp` (from your own IP if it is stable), `80/tcp`, `443/tcp` and `443/udp` (HTTP/3). Everything else inbound is dropped.
6. **DNS:** create an **A record** `chat.example.com -> <server IPv4>` before the first start (Let's Encrypt must reach the server over port 80). If the domain uses Hostinger's name servers, use hPanel's **DNS zone editor** *(as of writing, under the domain's DNS / nameservers page)*; if it is registered elsewhere, create the record at that DNS provider. Add an **AAAA** record only if the VPS has working public IPv6 (test with `curl -6 https://ifconfig.co`); a broken AAAA record makes certificate issuance fail intermittently. Check from your laptop: `dig +short chat.example.com` must print the server IP. A low TTL (300 s) helps while you set up.
7. **Snapshots / automatic backups** *(as of writing, a "Backups"/"Snapshots" section; frequency and retention depend on the plan, check them)*: switch them on, and also **take a manual snapshot before every upgrade**. They are a safety net, **not a replacement** for section 11.3: a disk snapshot of a running MySQL is only crash-consistent, it lives with the same provider, it is not encrypted by you, and a restore of the whole server is slow. Test-restore never happens unless you plan it.
8. **E-mail:** VPS providers commonly **block outbound port 25** to stop spam *(check Hostinger's current policy in hPanel/support)*. This stack never needs port 25: use a mail provider's submission port 587 (STARTTLS) or 465 (TLS), section 10.

---

## 4. Server hardening

Log in as `root` once and run these. Do them in this order and **keep your first SSH session open** until you have logged in successfully as the new user in a second window.

```bash
# 4.1 updates, a normal user, SSH keys only
apt update && apt -y upgrade
adduser deploy                         # choose a strong password; it is only used for sudo
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy   # copies your key (root's authorized_keys) to the new user
```

Open a **second terminal** and check `ssh deploy@<server IP>` works with your key and `sudo whoami` prints `root`. Only then:

```bash
# 4.2 SSH: keys only, no root login
cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t && systemctl reload ssh

# 4.3 firewall (second layer behind hPanel's): SSH rate-limited, web ports open
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp                       # or: ufw allow from <your IP> to any port 22 proto tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
ufw status verbose
```

**The Docker / `ufw` trap.** Docker publishes ports by writing its own `iptables` rules, **ahead of ufw's**. A `ports:` entry in a compose file is therefore reachable from the internet **whatever `ufw status` says** (`ufw deny 3306` does nothing for a published 3306). That is why `compose.prod.yml` publishes only 80 and 443 and why hPanel's firewall (which sits outside the VM) is the layer you can trust. Never add `ports:` to `mysql`, `redis`, `openwa`, `reverb` or `nats`; for a one-off debug tunnel bind to the loopback address (`"127.0.0.1:3306:3306"`) or use `ssh -L`.

```bash
# 4.4 automatic security updates (reboots at 04:00 only when a kernel update needs it; containers restart by themselves)
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades          # answer Yes
sed -i 's#^//\s*Unattended-Upgrade::Automatic-Reboot "false";#Unattended-Upgrade::Automatic-Reboot "true";#; s#^//\s*Unattended-Upgrade::Automatic-Reboot-Time "02:00";#Unattended-Upgrade::Automatic-Reboot-Time "04:00";#' /etc/apt/apt.conf.d/50unattended-upgrades

# 4.5 fail2ban (optional: with key-only SSH it mostly removes log noise)
apt install -y fail2ban
printf '[sshd]\nenabled = true\nmaxretry = 5\nfindtime = 10m\nbantime = 1h\n' > /etc/fail2ban/jail.d/sshd.local
systemctl enable --now fail2ban

# 4.6 time: UTC and NTP (TLS, two-factor codes and signed URLs all depend on a correct clock)
timedatectl set-timezone UTC
timedatectl set-ntp true
timedatectl | grep -E "Time zone|synchronized"      # System clock synchronized: yes

# 4.7 swap: a 2 GB file (the image build and OpenWA's browser spike above the RAM of a 4 GB server)
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf && sysctl --system > /dev/null
free -h
```

Docker's own log rotation is configured for **every service of this stack** in `compose.prod.yml` (10 MB x 5 files). To give containers you run by hand the same default, set it daemon-wide after section 5:

```bash
echo '{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker      # only affects containers created afterwards
```

From now on work as `deploy` (`exit`, then `ssh deploy@<server IP>`).

---

## 5. Install Docker

From Docker's **official apt repository** (not the `docker.io` package of the distribution, which lags):

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log out and in again (so the `docker` group applies), then verify:

```bash
docker run --rm hello-world          # "Hello from Docker!"
docker compose version               # Docker Compose version v2.xx or v5.xx (this guide was run with v5.5.1)
systemctl is-enabled docker          # enabled: containers come back after a reboot
```

The `docker` group is root-equivalent on that machine: only `deploy` is in it.

---

## 6. Get the code onto the server

The repository **has no remote yet**, so there are three ways. Pick one. The project lives in `/opt/pnechat` on the server.

```bash
sudo mkdir -p /opt/pnechat && sudo chown deploy:deploy /opt/pnechat
```

**A. From your own git remote** (GitHub, GitLab, your own server): push the repository there once (`git remote add origin <url>` and `git push -u origin main` on your laptop; a private repository), then on the server:

```bash
git clone <your remote URL> /opt/pnechat         # a private remote needs a deploy key: ssh-keygen -t ed25519 on the server, add the .pub as a read-only deploy key
cd /opt/pnechat && git checkout <tag or branch to deploy>
```

**B. Without a remote: `git archive` over SSH** (exactly the tracked files of one commit, no `.git` on the server; the simplest path from the laptop, run in the repository on your laptop):

```bash
git archive --format=tar HEAD | ssh deploy@<server IP> 'tar -x -C /opt/pnechat'
git describe --tags --always | ssh deploy@<server IP> 'cat > /opt/pnechat/RELEASE'      # optional: remember what is deployed (used for PNE_TAG in section 11.2)
```

To update later run the same command again; it overwrites tracked files and leaves `.env`, `backups/` and everything else untracked alone.

**C. Without a remote: `git bundle`** (a single file that carries the history; useful if you want `git` on the server):

```bash
# on the laptop
git bundle create pne-chat.bundle --all
scp pne-chat.bundle deploy@<server IP>:~/
# on the server
git clone ~/pne-chat.bundle /opt/pnechat && cd /opt/pnechat && git checkout main
# next release: create a new bundle, scp it, then in /opt/pnechat: git pull ~/pne-chat.bundle main
```

(`rsync -az --delete --exclude .git --exclude node_modules --exclude vendor --exclude .env --exclude backups ./ deploy@<server IP>:/opt/pnechat/` also works, but it can delete server-side files you did not mean to; `git archive` cannot.)

Whatever you choose: `cd /opt/pnechat && ls` must show `Dockerfile`, `compose.prod.yml`, `.env.production.example`, `docker/` and `scripts/`.

---

## 7. Configure `.env`

One file, `/opt/pnechat/.env`, read twice: by Compose (for `${...}` in `compose.prod.yml`) and by every application container (`env_file`). It holds secrets: **mode 600, never committed (it is in `.gitignore`), never pasted into a chat or a ticket, copied into your password manager.**

**Step 1: create it and fill in what only you know.** The helper copies `.env.production.example`, sets the domain and e-mail, and generates fresh random passwords for MySQL, Redis and OpenWA's key pepper with `openssl`:

```bash
cd /opt/pnechat
scripts/init-env.sh --domain chat.example.com --email you@example.com
```

(`--email` is where Let's Encrypt sends expiry notices; it also becomes the web-push contact. For a local test: `--domain localhost --email internal`.)

Open `.env` (`nano .env`) and review at least: `APP_NAME`, the `MAIL_*` block (section 10), `COMPOSE_PROFILES` (`whatsapp`, `nats`; empty for now), the memory limits if you chose a different size. Everything is documented in the file; the full list is in the appendix (14.1).

**Step 2: build the images** (the first build compiles PHP extensions and bundles the frontend: about 4 minutes cold on the 10-core test machine, expect 8-15 minutes on a 2 vCPU server, much less for later builds thanks to the layer cache; it needs the internet for the base images, composer, pnpm and the web fonts):

```bash
docker compose build
```

**Step 3: generate the secrets only PHP can make.** The freshly built image creates `APP_KEY`, the Reverb app id/key/secret, the web-push (VAPID) key pair and the one-time `SETUP_TOKEN`, writing them into your `.env` (existing values are never touched, so it is safe to run again):

```bash
scripts/init-env.sh --secrets
```

What each secret is, where it lives, and how to make it by hand if you prefer:

| Secret | Lives in | Made by | By hand |
|---|---|---|---|
| `DB_PASSWORD`, `REDIS_PASSWORD` | `.env` (MySQL/Redis read them at their **first** start) | `init-env.sh` step 1 | `openssl rand -hex 24` |
| `OPENWA_API_KEY_PEPPER` | `.env` (before OpenWA's first start) | `init-env.sh` step 1 | `openssl rand -hex 32` |
| `APP_KEY` | `.env`. **Also decrypts every encrypted setting in the database** (OpenWA key, pizzasys tokens): losing it loses those | `chat:bootstrap-secrets` | `echo "base64:$(openssl rand -base64 32)"` |
| `REVERB_APP_ID`, `REVERB_APP_KEY`, `REVERB_APP_SECRET` | `.env` (Reverb and the app read them) | `chat:bootstrap-secrets` | a 6-digit number, two random lower-case strings of 20 characters |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `.env` (push is off without both) | `chat:bootstrap-secrets` | `docker compose run --rm --no-deps app php artisan webpush:vapid --show` prints a pair |
| `SETUP_TOKEN` | `.env`, until the install is finished | `chat:bootstrap-secrets` | `openssl rand -hex 16` |
| OpenWA API key, pizzasys service/NATS tokens | **the database**, encrypted with `APP_KEY` (entered in the dashboard) | you | n/a |

Then lock the file and check it parses:

```bash
chmod 600 .env
docker compose config -q && echo "compose config OK"
grep -cE '^(APP_KEY|DB_PASSWORD|REDIS_PASSWORD|REVERB_APP_KEY|SETUP_TOKEN)=.+' .env      # 5
```

**What not to do:** do not commit `.env`; do not put `INSTALL_*` lines in it unless you use the non-interactive install (8.2) and remove them afterwards; do not set `APP_INSTALLED=true` before the installation.

**`APP_URL` / `APP_DOMAIN` / `REVERB_HOST`.** The helper wrote all three from `--domain` (`APP_URL=https://chat.example.com`: no port, no trailing slash on a real server; `REVERB_HOST=chat.example.com`); if you change the domain later, change the three together. `APP_URL` must equal what the wizard saves as the "Application URL" in step 8.2. `TRUSTED_PROXIES` stays **empty**: behind Caddy, php-fpm already receives the real client address and the https scheme (checked: a request from another container is recorded with its own address, and a forged `X-Forwarded-For` is ignored, with `TRUSTED_PROXIES` empty and with `*`). Fill it only when a CDN or load balancer sits in front of Caddy.

---

## 8. Build, start, first run

### 8.1 Start the stack

```bash
cd /opt/pnechat
docker compose up -d
docker compose ps
```

Expected (the first start takes about a minute: MySQL initialises its data directory once):

```text
SERVICE         STATUS
app             Up 20 seconds (healthy)
caddy           Up 15 seconds (healthy)
mysql           Up 40 seconds (healthy)
nats-consumer   Up 20 seconds (healthy)
queue           Up 20 seconds (healthy)
redis           Up 40 seconds (healthy)
reverb          Up 20 seconds (healthy)
scheduler       Up 20 seconds (healthy)
```

`queue`, `scheduler`, `reverb` and `nats-consumer` say `waiting for the setup wizard` in `docker compose logs queue` and are healthy: that is expected until 8.2 is done. `app` prints `Not installed yet: open https://chat.example.com/setup ...`.

Caddy now asks Let's Encrypt for a certificate (needs the DNS record of section 3 and port 80 open): `docker compose logs caddy | grep -i "certificate obtained"`. If it does not appear within a minute, see "Certificate not issued" in section 13. *(Verified here with `tls internal` only; real issuance needs a public DNS name.)*

### 8.2 The setup wizard

Open `https://chat.example.com/setup`. The page asks for the **setup token**: it is the `SETUP_TOKEN=` line of your `.env` (`grep ^SETUP_TOKEN= .env`). Five wrong tries a minute are refused. The wizard (flow and fields: [auth-modes.md](auth-modes.md), [contracts/setup-wizard.md](contracts/setup-wizard.md)):

1. **Environment check:** PHP version and extensions, writable storage, `APP_KEY`, the database and Redis connections. Everything must be green (a red line names the cause).
2. **Authentication mode** (cannot be changed afterwards):
   - **Mode 1, local accounts** (Fortify: passwords, two-factor, passkeys): the next page creates the first administrator (name, e-mail, a strong password: 12+ characters, mixed case, digits, symbols, not a known leaked one).
   - **Mode 2, pizzasys** (external sign-in; Admin/Agent come **only** from pizzasys roles): enter the portal's public `https://` base URL, the service-client **name and token** (made in the pizzasys admin for this application) and optionally its NATS address and token; use **Test connection**, then sign in once as a pizzasys administrator so nobody can lock themselves out. If the portal or its NATS server lives on a **private network** (VPN, another Docker network), add `PORTAL_ALLOW_PRIVATE_HOSTS=true` to `.env` and `docker compose up -d` *before* this step; for a public portal leave it `false`. Mode 2 was verified against a local clone of pizzasys in earlier phases, never against a production portal.
3. **Basics:** name, **Application URL**, language, time zone, idle timeout. **The Application URL must be your final `https://` origin, `https://chat.example.com`: no port, no trailing slash, no `http`.** Widget snippets, boot configs, the postMessage origin, WhatsApp webhook addresses and Reverb's allowed origin all derive from it; the wizard pre-fills it from the address you are visiting, check it.
4. **Run:** migrations, default data (a "General" topic and a disabled sample widget), the administrator, the lock. It takes a few seconds (2 s for the migrations on the test machine).
5. **Done.** `/setup` answers 404 from now on. The four workers notice the lock within five seconds and start (`docker compose ps` still shows them healthy; `docker compose logs queue` now shows jobs).

Then, in one go: remove the one-time token from `.env` (delete the value of `SETUP_TOKEN=` or the whole line) and, recommended, add `APP_INSTALLED=true` so a lost `storage` volume can never reopen `/setup` (section 1; verified: with it `/setup` stays 404 even with `installed.lock` deleted, and the workers start without the file). Apply:

```bash
nano .env                            # SETUP_TOKEN= (empty), and add the line: APP_INSTALLED=true
docker compose up -d                 # recreates what changed; php-fpm also turns on its config/route cache now (it started before the install)
```

**No browser available? The same installation from the command line** (it runs the same steps as the wizard; the answers come from `INSTALL_*` variables passed only to this one command):

```bash
docker compose run --rm --no-TTY \
  -e INSTALL_ADMIN_NAME="Your Name" -e INSTALL_ADMIN_EMAIL=you@example.com -e 'INSTALL_ADMIN_PASSWORD=<a strong password>' \
  -e INSTALL_APP_URL=https://chat.example.com \
  app php artisan chat:install --mode=local        # mode 2: --mode=pizzasys with the INSTALL_AUTH_* variables, see .env.production.example
```

(Verified: 14 s on a fresh stack. The password stays in your shell history: clear it with `history -d` or prefix the command with a space if `HISTCONTROL=ignorespace` is set.)

### 8.3 Optional: WhatsApp (OpenWA)

Read [whatsapp-openwa.md](whatsapp-openwa.md) first, in particular the **ban-risk** section: automating a WhatsApp number is against WhatsApp's terms and can get the number restricted or banned. Use a **dedicated number** (a spare SIM or eSIM), not a personal one, and only reply to customers who wrote first (the product's default).

1. In `.env`: `COMPOSE_PROFILES=whatsapp`, `PORTAL_ALLOW_PRIVATE_HOSTS=true` (the gateway's address `http://openwa:2785` is a private one; the switch is shared with the auth-portal guard) and a filled `OPENWA_API_KEY_PEPPER` (step 7 did it; it must be set **before** the gateway's first start). Then `docker compose up -d`. The pinned image (2.2 GB) downloads once; `docker compose ps openwa` becomes healthy in about 10-60 s (6 s measured with the image already present).
2. **Mint a key for the app** (an unscoped `operator` key; keep the admin key out of the app):
   ```bash
   ADMIN_KEY=$(docker compose exec -T openwa cat /app/data/.api-key)
   docker compose exec -T openwa curl -s -X POST http://localhost:2785/api/auth/api-keys \
     -H "X-API-Key: $ADMIN_KEY" -H 'Content-Type: application/json' -d '{"name":"pne-chat","role":"operator"}'
   # the plaintext key is in "apiKey", shown ONCE
   ```
3. Dashboard > **Settings > WhatsApp**: base URL `http://openwa:2785`, that key, enable, Save, **Test connection**. Expected `ok`, `role operator`, `engine whatsapp-web.js`, `canOperate true` (verified through the API with an admin key: `{"ok":true,"role":"admin","engine":"whatsapp-web.js","canOperate":true}`).
4. **The address OpenWA calls back.** The app registers `<Application URL>/webhooks/openwa/<session>` at OpenWA, and OpenWA must be able to reach exactly that address, with **no redirect** in front of it (a 302 counts as a failed delivery). Compose already arranges the two things this needs: Caddy gets your domain as a **network alias on the `whatsapp` network**, so inside Docker `chat.example.com` resolves to Caddy (no round trip through the internet, valid Let's Encrypt certificate), and OpenWA runs with `SSRF_ALLOWED_HOSTS=<your domain>` (its guard otherwise refuses any address that resolves to a private one). With `tls internal` OpenWA would not trust the certificate: use real certificates in production. *(Not verified end to end here: the callback needs a public name and a real session; the alias, the setting and the guard are verified separately.)*
5. Create a session, **Start**, scan the QR with the dedicated phone (WhatsApp > Linked devices), wait for `ready`. The login lives in the `openwa-data` volume: **back it up** (section 11.3) or you scan again.
6. Link the session to a widget, switch the channel on, publish. The first real-phone round trip is the checklist in [whatsapp-openwa.md](whatsapp-openwa.md) ("The real-device round trip").

OpenWA's own dashboard is deliberately not proxied. If you need it (Linux server): `ssh -L 2785:$(docker inspect -f '{{(index .NetworkSettings.Networks "pnechat_whatsapp").IPAddress}}' pnechat-openwa-1):2785 deploy@<server IP>`, then open `http://127.0.0.1:2785` on your laptop.

### 8.4 Optional: NATS

- **pizzasys' own NATS server** (mode 2): enter its address and token in Settings > Auth (or the wizard). The always-on `nats-consumer` switches itself on within 30 seconds. A public `tls://` address needs nothing else; a private address needs `PORTAL_ALLOW_PRIVATE_HOSTS=true`.
- **A NATS server of your own** (profile `nats`): `COMPOSE_PROFILES=nats` (or `whatsapp,nats`), `docker compose up -d`, then the address `nats://nats:4222` in Settings > Auth, with `PORTAL_ALLOW_PRIVATE_HOSTS=true`. It has no authentication, which is acceptable only because it is attached to the internal network alone.

---

## 9. Verification checklist

Run from your laptop (replace the domain) unless a command says `docker compose`. The outputs are the real ones from the test run (domain and ports adjusted).

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | All services healthy | `docker compose ps` | every line `(healthy)` |
| 2 | Application answers | `curl -sI https://chat.example.com/up` | `HTTP/2 200` |
| 3 | HTTP redirects to HTTPS | `curl -sI http://chat.example.com/login` | `308 Permanent Redirect`, `Location: https://chat.example.com/login` |
| 4 | A valid certificate | `curl -vI https://chat.example.com 2>&1 \| grep -E "issuer\|expire date"` | issuer `Let's Encrypt`, about 90 days *(not verified here)* |
| 5 | Sign-in page and headers | `curl -sI https://chat.example.com/login` | `HTTP/2 200`, `content-security-policy` (or `...-report-only`) with a `nonce-`, `strict-transport-security: max-age=31536000`, `x-frame-options: SAMEORIGIN`, `x-content-type-options: nosniff`, `referrer-policy`, `permissions-policy`, `cross-origin-opener-policy: same-origin`; **no** `server`/`via` header |
| 6 | The widget loader is the real one, served by Caddy | `curl -s https://chat.example.com/widget/v1/loader.js \| head -c 40` and `curl -sI .../widget/v1/loader.js` | starts with `/*! pne-chat-loader v1 */` (not a "bundle not built" comment), `cache-control: public, max-age=300`, an `etag`, `HTTP/2 304` with `If-None-Match` |
| 7 | Per-widget script (PHP) | `curl -sI https://chat.example.com/w/<widget key>.js` | `200`, `cache-control: max-age=60, public, stale-while-revalidate=300`, `vary: Referer`; with `-H 'Referer: https://evil.example/'` it is `403` |
| 8 | Static assets and caching | `curl -sI https://chat.example.com/sw.js`, `/build/assets/<file>`, `/manifest.webmanifest`, `/icons/icon-192.png` | `sw.js` `no-cache`; `/build/*` `public, max-age=31536000, immutable`; the manifest `application/manifest+json`; icons `max-age=604800` |
| 9 | Things that must not be reachable | `curl -s -o /dev/null -w '%{http_code}\n' https://chat.example.com/.env` (also `/.git/config`, `/storage/x`, `/apps/1/events`) | `404` each |
| 10 | Websocket through Caddy, allowed origin | `curl -s --http1.1 -i -N -m 2 "https://chat.example.com/app/<REVERB_APP_KEY>?protocol=7&client=js&version=8.4.0" -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: $(openssl rand -base64 16)" -H "Origin: https://chat.example.com"` | `HTTP/1.1 101 Switching Protocols`, then `{"event":"pusher:connection_established",...}` |
| 11 | Websocket, foreign or missing origin | the same with `-H "Origin: https://evil.example"` (or no Origin) | `101`, then `{"event":"pusher:error","data":"{\"code\":4009,\"message\":\"Origin not allowed\"}"}` |
| 12 | Scheduler is running | `docker compose logs --tail 5 scheduler` and `docker compose exec app php artisan schedule:list` | a line `Running ['artisan' chat:presence-sweep] ... DONE` every minute; 14 scheduled commands listed |
| 13 | Queue worker is processing | `docker compose logs --tail 5 queue` after any chat | `...Broadcasts\... RUNNING` / `... DONE` |
| 14 | A chat end to end | Open the sample widget's hosted page `https://chat.example.com/c/<key>` (enable and publish the widget, add your domain, assign yourself the topic, go online), write as a visitor | the offer appears in the inbox within about a second or two |
| 15 | The app sees real client IPs | sign in wrongly once, then `docker compose exec mysql sh -c 'MYSQL_PWD=$MYSQL_PASSWORD mysql -u$MYSQL_USER $MYSQL_DATABASE -e "select action,ip_address from audit_logs order by id desc limit 3"'` | your own public IP (not `172.x`) |
| 16 | Reverb uses the libuv loop | `docker compose exec reverb php -r 'require "vendor/autoload.php"; echo get_class(React\EventLoop\Loop::get());'` | `React\EventLoop\ExtUvLoop` (without `ext-uv` it would print `StreamSelectLoop` and die at about 1 000 sockets) |
| 17 | A restart keeps everything | `docker compose restart && sleep 20 && docker compose ps`, then `docker compose down && docker compose up -d` | healthy again, `/setup` still 404, you can sign in (volumes survive `down`; **never** `down -v`) |

Real values from the test run for a few of them: check 6 returned a 49 547 byte file with `cache-control: public, max-age=300` and an `etag`; check 12 printed lines like `Running ['artisan' chat:offer-waves] ...... 93.97ms DONE`; check 15 recorded `172.21.0.3`, the address of the helper container the request came from (on a real server: your public address).

---

## 10. E-mail (SMTP)

Offline tickets and replies to visitors are sent by e-mail from the queue worker. Fill the `MAIL_*` block in `.env`:

```ini
MAIL_MAILER=smtp
MAIL_SCHEME=smtp                 # port 587 with STARTTLS; use smtps for port 465 (implicit TLS)
MAIL_HOST=smtp.your-provider.example
MAIL_PORT=587
MAIL_USERNAME=...
MAIL_PASSWORD=...
MAIL_FROM_ADDRESS=chat@example.com
MAIL_FROM_NAME="PNE Chat"
```

Use the submission service of a transactional mail provider or of the mailbox provider of your domain (port 25 is commonly blocked, section 3). Make the sender address one your provider is allowed to send for, and publish SPF/DKIM for it, otherwise mails land in spam. Apply and test:

```bash
docker compose up -d
docker compose exec app php artisan tinker --execute '\Illuminate\Support\Facades\Mail::raw("PNE Chat test mail", fn ($m) => $m->to("you@example.com")->subject("PNE Chat SMTP test")); echo "handed to the mail transport\n";'
```

A wrong host, port or password raises the exception right there (nothing is queued by this command). The real mails (`OfflineTicketReply`) are **queued**: if a customer reports a missing reply, look at `docker compose logs queue` and `docker compose exec app php artisan queue:failed`. With `MAIL_MAILER=log` mails are only written to the log at `debug` level (`LOG_LEVEL=debug` to see them): fine for a trial, never for production.

---

## 11. Operations

All commands run in `/opt/pnechat`. (`docker compose` finds the stack through `COMPOSE_FILE=compose.prod.yml` in `.env`.)

### 11.1 Daily commands

```bash
docker compose ps                              # status and health
docker compose logs -f --tail 100 app          # one service; add more names; Ctrl-C leaves it running
docker compose logs --since 1h caddy | grep -v '"status":200'      # Caddy access log: one JSON object per request
docker compose restart reverb                  # restart one service (also: app, queue, scheduler, caddy)
docker compose up -d                           # apply a changed .env (only containers whose settings changed are recreated)
docker compose exec app php artisan about      # versions and drivers
docker compose exec app php artisan queue:failed
docker stats --no-stream                       # memory and CPU per container
docker system df                               # disk used by images, volumes, build cache
```

Logs: every service rotates at 10 MB x 5 files; the application writes to the container's stderr (`LOG_CHANNEL=stderr`), nothing accumulates inside the container. The NATS dead-letter file `storage/logs/nats-dead-letter.ndjson` is the one file log (metadata only).

### 11.2 Upgrade, with a rollback path

Take a **hPanel snapshot** (optional) and a **backup** first (11.3); then:

```bash
cd /opt/pnechat
scripts/backup.sh                                           # 1. backup
#   get the new code onto the server (section 6: git pull, or the git archive command again)
export PNE_TAG="$(cat RELEASE 2>/dev/null || git describe --tags --always)"     # 2. a tag for this release, e.g. v0.8.0 (it is also read from .env: PNE_TAG=...)
docker compose build                                        # 3. build the new images (the running stack keeps serving)
docker compose run --rm app php artisan migrate --force     # 4. database migrations (additive; run with the NEW image)
docker compose up -d                                        # 5. recreate the containers with the new images (a few seconds of 502 while app restarts)
docker compose ps && curl -sI https://chat.example.com/up | head -1
```

Put `PNE_TAG=<tag>` in `.env` instead of exporting it if you want it to stick. Nothing starts a migration by itself: if a release adds migrations and you skip step 4 the new code runs against the old schema. Verified: with nothing pending step 4 prints `Nothing to migrate.`; with a pending migration (a probe added to the image) it runs it and prints `DONE` (a rollback is not available in production: the framework refuses `migrate:rollback` there).

Optional maintenance page for long migrations: `docker compose exec app php artisan down --retry=60` before step 4 and `php artisan up` after step 5.

**Rollback.** Images are kept under their tags, so going back is: `PNE_TAG=<previous tag> docker compose up -d` (check `docker images | grep pnechat`; verified: a second tag was built, switched to and rolled back, all six containers re-created with the old images, `/up` 200 both times). If the new release changed the database schema, code-only rollback is not enough (migrations only go forward): restore the pre-upgrade backup (11.4) after rolling the tag back. Reclaim old images with `docker image prune` once a release has proved itself, and old build cache with `docker builder prune`.

The OpenWA image is pinned by **digest**: it does not change on an upgrade. To move to another version change `OPENWA_IMAGE` on purpose after `node scripts/openwa-smoke.mjs` and the fixture re-recording in [whatsapp-openwa.md](whatsapp-openwa.md) ("Versions").

### 11.3 Backups

What matters: the **MySQL database**, the **`storage` volume** (attachments, install lock), the **`openwa-data` volume** (the WhatsApp login) and **`.env`** (`APP_KEY`!). `scripts/backup.sh` takes all four while the application keeps running (a `--single-transaction` dump, a tar of `storage/app`, OpenWA stopped for the few seconds of its copy), writes them to `./backups/<UTC timestamp>/` with `SHA256SUMS`, can **encrypt** every file (AES-256, `openssl`), applies retention, and can hand the directory to a command that copies it off the server.

```bash
# one-off
BACKUP_PASSPHRASE='a long passphrase kept in your password manager' scripts/backup.sh

# nightly at 03:20: keep the passphrase in a file only you can read, then add the line to `crontab -e` of the deploy user
install -m 600 /dev/null ~/.pnechat-backup-key && nano ~/.pnechat-backup-key        # put the passphrase in it
sudo touch /var/log/pnechat-backup.log && sudo chown deploy /var/log/pnechat-backup.log
20 3 * * * cd /opt/pnechat && BACKUP_PASSPHRASE_FILE=$HOME/.pnechat-backup-key BACKUP_KEEP_DAYS=14 BACKUP_AFTER_COMMAND=/opt/pnechat/offsite.sh scripts/backup.sh >> /var/log/pnechat-backup.log 2>&1
```

`BACKUP_AFTER_COMMAND` is a command that is run after a successful backup with the backup directory as its **last argument**. Put your off-site copy in a small executable script of your own (`/opt/pnechat/offsite.sh`, not tracked by git), for example:

```bash
#!/bin/sh
# $1 is the new backup directory, e.g. /opt/pnechat/backups/20261002T032000Z
rclone copy "$1" "remote:pnechat-backups/$(basename "$1")"            # an object-storage bucket configured with `rclone config`
# or: rsync -a "$1" backup-user@backup-host:/srv/pnechat-backups/     # another server
```

**Off-site copy:** a backup on the same disk dies with the disk. Copy it to another provider (object storage via `rclone`, another server via `rsync`/`scp`) and keep the passphrase somewhere that is not that server. The backups hold customer conversations, your secrets and a WhatsApp login: **never store them unencrypted off the server**. Retention default 14 days (`BACKUP_KEEP_DAYS`, 0 keeps everything). The data-protection side (what an erasure does not reach: backups until they rotate) is in [security.md](security.md) "Data retention and erasure".

Redis holds only caches, queue entries and presence: it is not backed up (a lost queue entry is a missed push, not lost chat data; presence rebuilds with the next heartbeat).

### 11.4 Restore, and the restore drill

```bash
BACKUP_PASSPHRASE='...' scripts/restore.sh backups/20261002T031500Z          # asks you to type RESTORE
BACKUP_PASSPHRASE='...' scripts/restore.sh backups/20261002T031500Z --yes    # no question (drills)
```

It verifies the checksums, stops the application services, drops and re-creates the database and loads the dump, replaces `storage/app`, restores the OpenWA volume if the backup has one, and starts everything. On a **new server**: install Docker (section 5), put the code in place (6), copy the backup directory over, then

```bash
cd /opt/pnechat
BACKUP_PASSPHRASE='...' openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in backups/<timestamp>/env.backup.enc > .env && chmod 600 .env     # your old .env, APP_KEY included
docker compose build
BACKUP_PASSPHRASE='...' scripts/restore.sh backups/<timestamp> --yes
```

The DNS record must point at the new server before Caddy can issue certificates. (Without a passphrase `env.backup` is a plain copy of the file.)

**The drill, as run in this track** (the exit criterion "restore drill passes"; repeat it on your server before you trust a backup):

1. A chat with an image attachment, then `scripts/backup.sh` with a passphrase: 4 files (`mysql.sql.gz.enc`, `storage-app.tgz.enc`, `env.backup.enc`, `SHA256SUMS`), 1 s.
2. `docker compose down -v`: **every volume destroyed** (database, storage, certificates). `docker compose up -d`: an empty installation, `/login` redirects to `/setup`.
3. `scripts/restore.sh <dir> --yes`: 9 s.
4. Result: row counts of users / widgets / conversations / messages / settings / audit logs identical; `/setup` 404 again (lock restored); the same administrator signs in; the attachment, fetched through a signed URL, has the **same bytes** (sha256 identical).

Do the drill on a spare server or in a scratch project directory (`COMPOSE_PROJECT_NAME=drill`, different ports), never against production data you cannot afford to lose.

### 11.5 Monitoring

- **Uptime:** an external monitor (any service that can fetch a URL every minute and alert you by e-mail or SMS) on `https://chat.example.com/up` (`200`), plus one on the widget script `https://chat.example.com/widget/v1/loader.js`. It also tells you when the certificate or DNS breaks. Add a **dead-man's-switch** for the nightly backup (a URL your cron job fetches after a successful run; the service alerts you when the ping stops).
- **Disk and memory:** `df -h /` and `free -m` in a cron job that mails you above a threshold, or Hostinger's own resource graphs in hPanel *(as of writing, on the VPS overview; verify)*. Watch `docker system df` (build cache), `./backups` and the MySQL volume.
- **Inside:** `docker compose ps` (health), `docker compose logs --since 10m | grep -iE "error|exception|critical"`, `php artisan queue:failed`, the dashboard's Settings pages. Reverb exiting cleanly under load would appear as a restart count in `docker inspect pnechat-reverb-1 --format '{{.RestartCount}}'`.

### 11.6 Rotating secrets

| Secret | How | Effect |
|---|---|---|
| Database password | `docker compose exec mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" -e "ALTER USER CURRENT_USER() IDENTIFIED BY \"<new>\""'`, then put `<new>` in `.env` as `DB_PASSWORD`, `docker compose up -d` | the app reconnects after the restart; there is no root password to hand (it is random and unused) |
| Redis password | change `REDIS_PASSWORD`, `docker compose up -d` | everything restarts; sessions, cache and queue are lost (a signed-in person signs in again) |
| `SETUP_TOKEN` | remove it after the install (8.2) | n/a |
| Reverb key/secret | change the two values in `.env`, `docker compose up -d` | open websockets reconnect with the new key (the key is handed out dynamically) |
| VAPID pair | delete both lines, `scripts/init-env.sh --secrets`, `docker compose up -d` | **all push subscriptions become invalid**: everybody re-enables notifications |
| `APP_KEY` | not routine. Set the new key and put the old one in `APP_PREVIOUS_KEYS=base64:...` so old encrypted values stay readable, `docker compose up -d` | everybody is signed out (cookies); encrypted settings stay readable through the previous key until saved again. *Not rehearsed here*: take a backup first |
| OpenWA key / pizzasys service token | in the dashboard (Settings > WhatsApp / Auth), runbook "Rotating the pizzasys service token" | per [runbook.md](runbook.md) |
| Backup passphrase | make a new backup with the new passphrase; keep the old one for old files | n/a |

### 11.7 Break-glass

```bash
docker compose exec app php artisan chat:auth:test              # mode 2: portal reachable? service token? NATS?
docker compose exec app php artisan chat:auth:switch-env testing    # switch pizzasys production/testing without the UI
docker compose exec app php artisan chat:auth:reactivate someone@example.com
docker compose exec app php artisan chat:realtime-sweep         # retry a parked socket cut-off; `docker compose restart reverb` is the hard cut-off
docker compose exec app php artisan analytics:rollup --from=2026-01-01      # rebuild reports
```

Details and the full table: [runbook.md](runbook.md) ("Break-glass", "Auth portal operations", "Analytics"). **`chat:install:reset` wipes the database and only runs with `APP_ENV=local`: it does not run in this stack and must never be made to.** A forgotten administrator password in mode 1: use the sign-in page's "Forgot password" once SMTP works (section 10). As a last resort, without mail (verified): `docker compose exec app php artisan tinker --execute '$u = App\Models\User::where("email", "you@example.com")->firstOrFail(); $u->password = "a-new-strong-password"; $u->save();'` (put a space before the command so your shell history does not keep the password).

**Re-pairing WhatsApp** (the phone unlinked the device, was offline for weeks, or you restored an old `openwa-data`): Settings > WhatsApp > the session shows `disconnected`; press **Start**. No scan is needed while OpenWA still holds the login; otherwise the QR appears (it refreshes about every minute) and you scan it from Linked devices on the dedicated phone ([runbook.md](runbook.md) "WhatsApp (OpenWA) operations").

### 11.8 Scaling and one-off containers

- More queue workers: `docker compose up -d --scale queue=2` (the scheduler and Reverb must stay at one).
- A one-off command in a clean container: `docker compose run --rm --no-deps app php artisan <command>`; the same service definition (read-only file system, tmpfs, `storage` volume) applies.
- Several Reverb instances (`REVERB_SCALING_ENABLED=true`) were not tested; one Reverb carried 2 500 sockets.

---

## 12. Security checklist

- [ ] DNS points at the server; Let's Encrypt issued a certificate; `http://` redirects to `https://`; `curl -sI` shows HSTS.
- [ ] **`CSP_MODE=enforce`** after you ran the browser checklist in [testing.md](testing.md) ("CSP verification checklist") with `report-only` first. The policy was derived from the code and proven on the HTML only (a crawl of every page type); it has **not** been seen by a real browser yet, which is why `.env.production.example` ships `report-only`. Switch, `docker compose up -d`, check `curl -sI .../login | grep -i content-security-policy` shows an enforcing header.
- [ ] Cookies: `SESSION_SECURE_COOKIE=true`, `SESSION_SAME_SITE=lax`, `APP_ENV=production`, `APP_DEBUG=false` (all in the example file).
- [ ] **Only 80/443 are published** (`docker compose ps` shows ports for `caddy` only; `ss -tlnp` on the host shows nothing for 3306, 6379, 8080, 2785, 4222); hPanel firewall and `ufw` as in sections 3 and 4.
- [ ] MySQL, Redis, OpenWA, Reverb and NATS have no `ports:`; OpenWA shares no network with MySQL or Redis (verified: `getent hosts mysql` fails inside it).
- [ ] `TRUSTED_PROXIES` empty unless a CDN/proxy is in front of Caddy.
- [ ] `SETUP_TOKEN` removed from `.env` after the installation; `INSTALL_*` never left in `.env`; optionally `APP_INSTALLED=true`.
- [ ] Strong passwords: `DB_PASSWORD`/`REDIS_PASSWORD` generated (24 random bytes), the administrator's password 12+ characters (the application enforces it in production), two-factor on for every administrator (Settings > Security).
- [ ] `.env` is mode 600, not in git, copied to your password manager; backups are **encrypted and copied off the server**; the restore drill has been run once.
- [ ] SSH: keys only, no root login, `ufw` on, fail2ban (optional), unattended upgrades on, time synchronised.
- [ ] Updates: apply OS updates (unattended), rebuild images regularly (base-image fixes arrive with new builds: `docker compose build --pull && docker compose up -d` after a backup), watch `composer audit` / `pnpm audit` on the code side.
- [ ] Widget domain whitelists contain only the https origins that really embed the widget (a bare entry admits https only).
- [ ] WhatsApp: a dedicated number, reply-only-to-inbound left on, OpenWA's dashboard not published, `API_KEY_PEPPER` set before keys were minted.
- [ ] Open items from [security.md](security.md) ("Still open"): a CSP for the visitor panel `/embed`, rate limiting/WAF in front of the public widget endpoints at Caddy (not part of this stack: Caddy's rate limiting needs a plugin build), a real-phone WhatsApp round trip.

---

## 13. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Browser says the certificate is invalid, `docker compose logs caddy` shows `obtaining certificate` errors | The DNS record does not point at this server yet, port 80 is blocked (hPanel firewall / ufw), a stale AAAA record, or Let's Encrypt rate limits after many failed tries | `dig +short chat.example.com` = server IP; `curl -I http://chat.example.com` from outside answers; remove a wrong AAAA record; wait an hour after repeated failures. The `caddy-data` volume keeps issued certificates across restarts (do not delete it). While testing use `CADDY_TLS=internal` |
| `502 Bad Gateway` from Caddy | `app` is not healthy (php-fpm down, crash loop) or still starting | `docker compose ps`, `docker compose logs app`; `docker compose exec app pne-healthcheck fpm; echo $?` (0 = ok); `docker compose restart app`. A few seconds of 502 during an upgrade are normal |
| Dashboard works but live updates do not (the inbox needs a reload) | Websocket blocked or Reverb down | `docker compose ps reverb`; checks 10/11 of section 9; browser dev tools > Network > WS; the "realtime" block missing from `/api/v1/auth/token` answers means `BROADCAST_CONNECTION`/`REVERB_*` is not set (the app then falls back to polling by design) |
| `pusher:error 4009 Origin not allowed` | The page's origin host is not the host of `APP_URL` and not in `REVERB_ALLOWED_ORIGINS` | Fix `APP_URL`/the wizard's Application URL; the saved URL's host is added when Reverb starts: `docker compose restart reverb` after changing it |
| Everyone appears to have the same IP / throttling hits all visitors at once | A proxy or CDN in front of Caddy hides the client | Set `TRUSTED_PROXIES` to that proxy's addresses (and Caddy's `servers { trusted_proxies ... }`); without a proxy leave it empty (checked) |
| Queued things never happen (no push, no mail, offers arrive late, WhatsApp replies stay `pending`) | `queue` is not running or the install lock is missing | `docker compose ps queue`; `docker compose logs queue` (`waiting for the setup wizard` means no `installed.lock`); `php artisan queue:failed`; Redis healthy? |
| Chats never time out, nothing closes, analytics empty, presence stale | `scheduler` is not running | `docker compose logs scheduler` must show a run every minute; `docker compose exec app php artisan schedule:list` |
| `Permission denied` / `Unable to create directory` in the app log | The `storage` volume is not writable by uid 33 (a restored or bind-mounted one) | `docker compose run --rm --no-deps --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint chown app -R 33:33 /var/www/html/storage` |
| `/setup` is 404 and you want to reinstall | That is the lock working | By design. A real reinstall means `docker compose down -v` (destroys everything: take a backup first) |
| `/setup` appears on an installed system | The `storage` volume was lost or replaced | Section 1: restore the backup, or run the wizard once (it restores the lock), or set `APP_INSTALLED=true` |
| Login: "419 Page expired" or the form loops | Cookies/host mismatch: you opened the site by IP or another host name than `APP_URL`, or `SESSION_SECURE_COOKIE=true` on plain http | Use the https domain; check `APP_URL`; clear cookies |
| OpenWA cannot call back (`webhook_rejected`, deliveries missing) | `app.url` is not an https address OpenWA can reach, a redirect in front of it, a private name not in `SSRF_ALLOWED_HOSTS`, `tls internal` certificate | Section 8.3 step 4; [whatsapp-openwa.md](whatsapp-openwa.md) troubleshooting; from inside: `docker compose exec openwa curl -sI https://chat.example.com/up` |
| Push notifications do not arrive | VAPID keys missing (`init-env.sh --secrets`), the browser denied notifications, the queue is down, the push service endpoint is refused by the SSRF guard | [notifications.md](notifications.md); `docker compose logs queue \| grep -i push`; Settings > Notifications "Send a test notification" |
| Reverb exits at about 1 000 sockets with no error | An image without `ext-uv` (stream_select limit) | Not this stack: check 16 of section 9 prints `ExtUvLoop`. A restart policy of `on-failure` would not restart an exit code 0: this stack uses `unless-stopped` |
| `docker compose build` is killed (`signal: killed`) or hangs | Out of memory on a small server | Add swap (4.7), build with nothing else running, or build on your laptop and `docker save | ssh server docker load` |
| `mysql` is `unhealthy` after changing `DB_PASSWORD` | The password in `.env` is only read at MySQL's **first** initialisation | Use the `ALTER USER` procedure of 11.6, or restore `.env` |
| A page is unstyled or toasts/scrollbars look wrong after switching to `enforce` | A CSP violation | Browser console `Refused to ...`; set `CSP_MODE=report-only` and read the log lines `csp.violation`; [security.md](security.md) |
| Disk full | Build cache, old images, backups, logs | `docker system df`; `docker builder prune`; `docker image prune`; `du -sh backups`; the stack's logs are capped |

---

## 14. Appendix

### 14.1 Environment variable reference

Names are checked against `config/*.php` (and the compose file for the Compose-only ones). The example file `.env.production.example` is the working template; "set by compose" means the stack overrides it so it cannot drift from the service names.

**Compose and Caddy (read by `compose.prod.yml`)**

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `pnechat` | Prefix of containers, networks and volumes (`pnechat_storage`, ...) |
| `COMPOSE_FILE` | `compose.prod.yml` | Lets `docker compose` run without `-f` |
| `COMPOSE_PROFILES` | empty | `whatsapp`, `nats` (comma separated) |
| `APP_DOMAIN` | required | Public host name (Caddy site address, OpenWA allow-list, network alias) |
| `CADDY_TLS` | required | Your e-mail (Let's Encrypt) or `internal` (Caddy's own CA) |
| `HTTP_PORT`, `HTTPS_PORT` | `80`, `443` | Published ports (other values for local tests only: the HTTP redirect then drops the port) |
| `PNE_TAG`, `PNE_IMAGE_APP`, `PNE_IMAGE_WEB` | `latest`, `pnechat-app`, `pnechat-web` | Image names/tags (rollback by tag) |
| `APP_MEM_LIMIT`, `QUEUE_MEM_LIMIT`, `SCHEDULER_MEM_LIMIT`, `REVERB_MEM_LIMIT`, `NATS_CONSUMER_MEM_LIMIT`, `MYSQL_MEM_LIMIT`, `REDIS_MEM_LIMIT`, `CADDY_MEM_LIMIT`, `OPENWA_MEM_LIMIT`, `NATS_MEM_LIMIT`, `OPENWA_CPUS` | `1g`, `512m`, `384m`, `512m`, `256m`, `1g`, `512m`, `512m`, `1536m`, `256m`, `1.0` | Container ceilings |
| `CADDY_GOMEMLIMIT` | `400MiB` | Soft memory target of Caddy's garbage collector |
| `REDIS_MAXMEMORY` | `384mb` | Redis refuses writes above it (`noeviction`) |
| `OPENWA_API_KEY_PEPPER`, `OPENWA_IMAGE` | empty, the pinned digest | OpenWA key hashing; image override |
| `FPM_MAX_CHILDREN`, `FPM_START_SERVERS`, `FPM_MIN_SPARE_SERVERS`, `FPM_MAX_SPARE_SERVERS` | `16`, `4`, `2`, `8` | php-fpm pool |
| `APP_OPTIMIZE` | `true` | Cache config/routes/events at start (only once installed) |
| `CHAT_WAIT_FOR_INSTALL`, `CHAT_ROLE` | set by compose | Worker waits for the lock; the `app` role prints the setup hint |

**Application (read by `config/*.php`)**

| Variable | Default here | Meaning |
|---|---|---|
| `APP_NAME`, `APP_ENV`, `APP_DEBUG`, `APP_KEY`, `APP_URL`, `APP_LOCALE`, `APP_FALLBACK_LOCALE`, `APP_PREVIOUS_KEYS` | see example | Core; `APP_ENV=production` keeps the setup token mandatory |
| `LOG_CHANNEL`, `LOG_LEVEL` | `stderr`, `info` | Logs to `docker compose logs` |
| `TRUSTED_PROXIES` | empty | Proxies whose `X-Forwarded-*` are trusted (see section 7) |
| `SETUP_TOKEN` | generated | Wizard guard; remove after install |
| `APP_INSTALLED` | unset | `true` = installed even without the lock file |
| `INSTALL_*` (`ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `APP_NAME`, `APP_URL`, `LOCALE`, `TIMEZONE`, `IDLE_TIMEOUT_MINUTES`, `AUTH_*`) | unset | Only for `chat:install` |
| `DB_CONNECTION`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | `mysql`, `chatfeature`, `chatfeature`, generated | Database; `DB_HOST`/`DB_PORT` are set by compose (`mysql`, `3306`) |
| `REDIS_CLIENT`, `REDIS_PASSWORD` | `phpredis`, generated | `REDIS_HOST`/`REDIS_PORT` set by compose |
| `CACHE_STORE`, `QUEUE_CONNECTION`, `SESSION_DRIVER` | `redis` | Must stay shared between processes |
| `SESSION_LIFETIME`, `SESSION_SECURE_COOKIE`, `SESSION_SAME_SITE`, `SESSION_ENCRYPT` | `120`, `true`, `lax`, `false` | Session cookie |
| `SANCTUM_EXPIRATION_MINUTES` | `43200` | Staff API token lifetime |
| `BROADCAST_CONNECTION` | `reverb` | Falls back to `null` while a Reverb value is missing |
| `REVERB_APP_ID`, `REVERB_APP_KEY`, `REVERB_APP_SECRET` | generated | Reverb application |
| `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` | your domain, `443`, `https` | **Public** address clients connect to |
| `REVERB_SERVER_HOST`, `REVERB_SERVER_PORT`, `REVERB_PUBLISH_HOST`, `REVERB_PUBLISH_PORT`, `REVERB_PUBLISH_SCHEME` | set by compose | `0.0.0.0:8080` where it listens, `reverb:8080` over `http` where the app publishes |
| `REVERB_ALLOWED_ORIGINS` | empty | Extra websocket origins; never `*` |
| `REVERB_APP_MAX_CONNECTIONS`, `REVERB_APP_PING_INTERVAL`, `REVERB_APP_ACTIVITY_TIMEOUT`, `REVERB_MAX_REQUEST_SIZE`, `REVERB_APP_MAX_MESSAGE_SIZE`, `REVERB_APP_RATE_LIMITING_ENABLED`, `REVERB_SCALING_ENABLED` | unset | See [realtime.md](realtime.md) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_ALLOWED_HOSTS`, `PUSH_QUEUE` | generated / example | Web Push ([notifications.md](notifications.md)) |
| `MAIL_MAILER`, `MAIL_SCHEME`, `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | example | SMTP (section 10) |
| `CSP_MODE`, `CSP_REPORT_URI`, `SECURITY_HSTS_MAX_AGE`, `SECURITY_HSTS_INCLUDE_SUBDOMAINS` | `report-only`, `/csp-report`, `31536000`, off | Browser security headers |
| `PORTAL_ALLOW_PRIVATE_HOSTS` | `false` | Allow private-network portal / NATS / OpenWA addresses |
| `NATS_TLS_CA_FILE` | empty | CA bundle (a path inside the containers) for a NATS server with a private CA; the other `NATS_*` only feed development |
| `PRESENCE_STORE`, `PRESENCE_HEARTBEAT_WINDOW`, `PRESENCE_AUTO_AWAY_MINUTES`, `PRESENCE_REDIS_CONNECTION`, `PRESENCE_REDIS_PREFIX` | defaults | Agent presence |
| `REALTIME_QUEUE`, `REALTIME_AUTH_PER_TOKEN`, `REALTIME_AUTH_PER_NETWORK`, `REALTIME_TAG_PRIVATE_CHANNELS` | defaults | Realtime tuning |
| `DB_QUEUE_RETRY_AFTER`, `REDIS_QUEUE_RETRY_AFTER` | `300` | Must exceed every job timeout (150 s) and `queue:work --timeout` (180 s) |
| `CHAT_ATTACHMENTS_DISK`, `WHATSAPP_MEDIA_DISK`, `FILESYSTEM_DISK` | `local` | Both land in the `storage` volume |
| `ANALYTICS_LIVE_TTL`, `ANALYTICS_REPORT_TTL`, `ANALYTICS_PAST_REPORT_TTL`, `WHATSAPP_WEBHOOK_RATE_PER_SESSION`, `WHATSAPP_WEBHOOK_RATE_PER_NETWORK` | defaults | Tuning |

### 14.2 Ports

| Port | Where | Open to |
|---|---|---|
| 80/tcp, 443/tcp, 443/udp | host -> `caddy` | the internet |
| 22/tcp | host `sshd` | you (restrict by IP) |
| 8080 | `reverb` | the `internal` network only |
| 3306, 6379, 2785, 4222 | `mysql`, `redis`, `openwa`, `nats` | their networks only |
| 2019 | Caddy admin API | the container's loopback only |

### 14.3 Volumes (prefix `pnechat_`)

| Volume | Holds | Back up | If lost |
|---|---|---|---|
| `mysql-data` | the database | yes (dump) | restore the dump; without one, all conversations are gone |
| `storage` | `installed.lock`, attachments, WhatsApp media | yes (`app/`) | see section 1 |
| `redis-data` | AOF of cache/queue/presence | no | sessions end, queued jobs are lost, presence rebuilds |
| `openwa-data` | the WhatsApp login, OpenWA keys | yes | scan the QR again, new OpenWA key |
| `caddy-data` | certificates, ACME account | optional | new certificates are issued (mind Let's Encrypt's rate limits) |
| `caddy-config` | Caddy autosave | no | n/a |
| `fpm-socket` | the php-fpm socket | no | recreated |
| `nats-data` | optional NATS JetStream | no | the consumer re-creates its durable (events are only hints) |

### 14.4 Command cheat sheet

```bash
docker compose ps | logs -f <svc> | restart <svc> | up -d | down            # (never `down -v`)
docker compose build [--pull]                                                # new images
docker compose run --rm app php artisan migrate --force                      # after every upgrade
docker compose exec app php artisan schedule:list | queue:failed | about
scripts/init-env.sh --domain D --email E ; scripts/init-env.sh --secrets      # create .env
scripts/backup.sh ; scripts/restore.sh backups/<ts> [--yes] [--with-env]
PNE_TAG=<old> docker compose up -d                                           # roll the images back
docker compose --profile whatsapp up -d openwa                               # or COMPOSE_PROFILES=whatsapp in .env
```

Build notes: the frontend is built with **pnpm** from `pnpm-lock.yaml` (pinned pnpm 10.28.2, Node 24); `package-lock.json` in the repository is a stale leftover of phase 0 (it lacks cmdk, recharts, radix-ui ...: `npm ci` refuses it) and is ignored by the image build. `vp build` runs `php artisan wayfinder:generate --with-form` through the Wayfinder plugin, which is why the frontend stage also contains PHP and the production `vendor/`. `jetbrains/phpstorm-stubs` (113 MB, pulled in by the dev-time TypeScript generator) is pruned from the image except its autoloaded map file. Base images are floating tags (`php:8.4-fpm-bookworm`, `node:24-bookworm-slim`, `caddy:2-alpine`, `mysql:8.4`, `redis:7-alpine`): to freeze them, replace a tag by `image@sha256:<digest>` (read it with `docker buildx imagetools inspect <image>`); this run used php `sha256:43e1ac38...5d0` (PHP 8.4.26), Caddy 2.11.4, MySQL 8.4.11, Redis 7.4.11, NATS 2.11.17.

Files of this deployment: `Dockerfile` (stages: `base`, `vendor`, `frontend`, `app`, `web`), `.dockerignore` (an allow-list: tests, docs, `.git`, `.env*`, `node_modules`, e2e artefacts and screenshots never enter the build), `compose.prod.yml`, `docker/caddy/Caddyfile`, `docker/php/{pne.ini,www.conf}`, `docker/mysql/my.cnf`, `docker/entrypoint.sh`, `docker/healthcheck.sh`, `.env.production.example`, `scripts/{init-env,backup,restore}.sh`.

### 14.5 What was and was not verified

**Run and observed** (development Mac, Docker Desktop 29.8, Compose 5.5.1, arm64, project `pnechat-p8`, `tls internal`, ports 18080/18443):

- Image builds (cold and cached); `app` image 422 MB uncompressed (the first version of this image, before the compiler toolchain of the official `php:8.4-fpm` base was removed and the layers flattened, was 973 MB), `web` image 89 MB; no dev packages, tests, docs, `.env`, `.git` or `node_modules` inside; the loader is 16.44 kB gzip (budget 18) and the build runs `pnpm run size`.
- Stack up in 59 s on an empty machine (MySQL initialisation included), 11 s for `down` + `up` with volumes, 3 s for `restart`.
- The setup wizard endpoints driven with curl over https (wrong token 422, token 302, mode/admin/basics, four run steps, `/setup` 404 afterwards); `chat:install --mode=local` on a fresh project (14 s); lock recovery from the database; `migrate --force` with and without a pending migration.
- `/up`, `/login` with every security header and a per-request nonce, HSTS, the loader and `/w/<key>.js` caching, `sw.js`, manifest, icons, blocked paths, HTTP redirect, an unknown host name (TLS handshake refused).
- Staff sign-in token, widget/topic/domains/publish through the API, a visitor session and chat, **`chat.offered` and `conversation.updated` reaching a staff websocket through Caddy (`wss://`; 0.73 s with `queue:work --sleep=1`, 2.3 s with the first value of 3)**, message and reply in both directions over `wss://`: 21 of 21 checks.
- Scheduler running every minute (14 commands), queue worker processing jobs, `analytics:rollup` and `chat:presence-sweep` executing (the scheduled hourly rollup itself was not observed running).
- Client IP behind Caddy (real container address recorded, spoofed `X-Forwarded-For` ignored, with `TRUSTED_PROXIES` empty and `*`).
- Reverb on `ExtUvLoop` (`ext-uv` 0.3.1), `nofile` 65 536; **2 500 websockets held for 30 s through Caddy, 0 failed, 0 dropped**; 1 513 open descriptors in the Reverb process at 1 500 sockets; Reverb 110-125 MB, Caddy up to 382 MB; no restarts, no OOM.
- Encrypted backup, `down -v`, restore: identical rows, same attachment bytes, install state restored.
- OpenWA profile: starts healthy in 6 s, **Test connection from the app returns ok/admin/whatsapp-web.js/canOperate**, no network path to MySQL, Redis or Reverb; NATS profile starts.
- Container hardening: non-root, read-only root, `CapEff 0` (Caddy: only `NET_BIND_SERVICE`), `NoNewPrivs`.

**amd64:** the `app` image was also **built for `linux/amd64` under emulation** (Docker Desktop on Apple silicon) and smoke-tested: `uname -m` = `x86_64`, PHP 8.4.26 with `uv`, `gd`, `redis`, `pdo_mysql`, `intl`, `pcntl`, `gmp`, `exif`, `bcmath`, `zip`, `sockets`, OPcache; ReactPHP picks `ExtUvLoop`; `artisan` boots; the loader bundle is 16.44 kB gzip. The **whole stack** was not run on amd64.

**Not verified:** real Let's Encrypt issuance (needs a public name); a real Hostinger VPS, hPanel, its firewall, snapshots and templates; an **amd64** server (a Hostinger VPS is presumably x86-64, check `uname -m` after the first login; the stack was run on arm64 only, the amd64 `app` image was only built and smoke-tested, see the note above); Docker/ufw behaviour on Linux; the OpenWA webhook callback end to end and any real WhatsApp phone; a real pizzasys portal and a pizzasys-fed NATS; the CSP in a real browser; Caddy at 2 500 sockets on a small server; chat throughput of the php-fpm stack (no load tool for it); the hPanel-side items of section 3; rotating `APP_KEY`.
