#!/usr/bin/env bash
# Backup of a PNE Chat production stack (compose.prod.yml), run on the SERVER from the repository directory:
#
#   scripts/backup.sh                      # one backup into ./backups/<UTC timestamp>/
#
# What it saves (a consistent set, taken while the application keeps running):
#   mysql.sql.gz       mysqldump --single-transaction of the application database
#   storage-app.tgz    the `storage` volume's app/ directory: chat attachments, WhatsApp media, installed.lock, install-state.json
#   openwa-data.tgz    the OpenWA volume (the WhatsApp login; only when the `whatsapp` profile's volume exists; OpenWA is stopped for
#                      a few seconds so the copy is consistent and starts again by itself)
#   env.backup         your .env (APP_KEY inside: without it encrypted settings are unreadable)
#   SHA256SUMS         checksums of the files above
#
# Environment (all optional):
#   BACKUP_DIR            where backups go (default ./backups)
#   BACKUP_KEEP_DAYS      delete backups older than this many days (default 14; 0 = keep everything)
#   BACKUP_PASSPHRASE     encrypt every file with AES-256 (openssl, PBKDF2): files get a .enc suffix. STRONGLY recommended:
#                         the archives contain customer conversations, your secrets and a WhatsApp login. (BACKUP_PASSPHRASE_FILE: read it from a file)
#   BACKUP_AFTER_COMMAND  a command run after a successful backup with the backup directory as its argument, to copy it off the
#                         server, e.g. 'rsync -a --delete-after' or a script that calls rclone / scp
#   COMPOSE_FILE, ENV_FILE  default: the COMPOSE_FILE line of .env, else compose.prod.yml (a colon-separated list is fine), and .env
#
# Cron (every night at 03:20, log to a file):
#   20 3 * * * cd /opt/pnechat && BACKUP_PASSPHRASE_FILE=/root/.pnechat-backup-key scripts/backup.sh >> /var/log/pnechat-backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
# COMPOSE_FILE: the shell variable, else the line of the env file (`scripts/init-env.sh --nginx` writes compose.prod.yml:compose.nginx.yml there),
# else compose.prod.yml. A colon-separated list, like Docker's own variable: every file becomes a `-f`, so the override that replaces the edge
# service (compose.nginx.yml) is never forgotten, and `up` never starts the stock Caddy next to the host's nginx.
if [ -z "${COMPOSE_FILE:-}" ] && [ -f "$ENV_FILE" ]; then
    COMPOSE_FILE="$(grep -E '^COMPOSE_FILE=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
fi
COMPOSE_FILE="${COMPOSE_FILE:-compose.prod.yml}"
compose_files=()
IFS=: read -r -a _compose_list <<< "$COMPOSE_FILE"
for _file in "${_compose_list[@]}"; do compose_files+=(-f "$_file"); done
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    BACKUP_PASSPHRASE="$(cat "$BACKUP_PASSPHRASE_FILE")"
fi

dc() { docker compose "${compose_files[@]}" --env-file "$ENV_FILE" "$@"; }
log() { echo "[backup $(date -u +%H:%M:%S)] $*"; }
die() { echo "[backup] ERROR: $*" >&2; exit 1; }

sha256() {
    if command -v sha256sum > /dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# encrypt_stream: stdin -> stdout, encrypted when a passphrase is set.
encrypt_stream() {
    if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
        BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE
    else
        cat
    fi
}

suffix=""
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
    suffix=".enc"
else
    log "WARNING: BACKUP_PASSPHRASE is not set, the files are NOT encrypted (they hold customer data and secrets)."
fi

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found (run from the repository directory)."
dc ps --status running --services 2> /dev/null | grep -qx mysql || die "the mysql service is not running (docker compose ps)."

umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/$stamp"
mkdir -p "$target"
log "backup into $target"

# --- MySQL -------------------------------------------------------------------------------------------------------------
# The application user owns the database and is enough for a dump; the root password is random and never needed.
log "dumping MySQL ..."
dc exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --no-tablespaces --routines --triggers --events --hex-blob --default-character-set=utf8mb4 --set-gtid-purged=OFF "$MYSQL_DATABASE"' \
    | gzip -9 | encrypt_stream > "$target/mysql.sql.gz$suffix"

# A truncated dump has no trailer: read it back before trusting it.
if [ -n "$suffix" ]; then
    BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$target/mysql.sql.gz$suffix" | gzip -dc | tail -n 3 | grep -q 'Dump completed' \
        || die "the MySQL dump looks truncated."
else
    gzip -dc "$target/mysql.sql.gz" | tail -n 3 | grep -q 'Dump completed' || die "the MySQL dump looks truncated."
fi

# --- storage volume (attachments, installed.lock) ---------------------------------------------------------------------------
# framework/ (cache, compiled views) and logs/ are rebuilt by the application and left out.
log "archiving the storage volume ..."
dc run --rm --no-deps -T --entrypoint tar app czf - -C /var/www/html/storage app \
    | encrypt_stream > "$target/storage-app.tgz$suffix"

# --- OpenWA volume (WhatsApp login), only if it exists --------------------------------------------------------------------
# OpenWA's files belong to its own user and are mode 0600: read them as root, with only the capability to read (cap_drop ALL stays).
failed=0
project="$(dc config --format json 2> /dev/null | sed -n 's/^  "name": "\(.*\)",\{0,1\}$/\1/p' | head -n 1)"
openwa_volume="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.volume=openwa-data" | head -n 1)"
if [ -n "$openwa_volume" ]; then
    log "archiving the OpenWA volume ($openwa_volume) ..."
    openwa_running=false
    if dc ps --status running --services 2> /dev/null | grep -qx openwa; then
        openwa_running=true
        dc stop openwa > /dev/null
    fi
    if ! dc run --rm --no-deps -T --user root --cap-add DAC_READ_SEARCH -v "$openwa_volume":/openwa:ro --entrypoint tar app czf - -C /openwa . \
        | encrypt_stream > "$target/openwa-data.tgz$suffix"; then
        rm -f "$target/openwa-data.tgz$suffix"
        log "ERROR: the OpenWA archive failed (it is missing from this backup)."
        failed=1
    fi
    if [ "$openwa_running" = true ]; then
        dc start openwa > /dev/null
    fi
fi

# --- .env --------------------------------------------------------------------------------------------------------------
encrypt_stream < "$ENV_FILE" > "$target/env.backup$suffix"

# --- checksums -----------------------------------------------------------------------------------------------------------
( cd "$target" && sha256 -- * > SHA256SUMS.tmp && mv SHA256SUMS.tmp SHA256SUMS )
log "done: $(du -sh "$target" | cut -f1) in $(ls "$target" | wc -l | tr -d ' ') files"

# --- retention ------------------------------------------------------------------------------------------------------------
if [ "$KEEP_DAYS" -gt 0 ]; then
    find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '2*T*Z' -mtime +"$KEEP_DAYS" -print -exec rm -rf {} + | sed 's/^/[backup] removed old backup /' || true
fi

# --- off-site copy ----------------------------------------------------------------------------------------------------------
if [ -n "${BACKUP_AFTER_COMMAND:-}" ]; then
    log "running BACKUP_AFTER_COMMAND ..."
    # shellcheck disable=SC2086
    $BACKUP_AFTER_COMMAND "$target"
fi

echo "$target"
if [ "$failed" -ne 0 ]; then
    die "the backup is INCOMPLETE (see above)."
fi
