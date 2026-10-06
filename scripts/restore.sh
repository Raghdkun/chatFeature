#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh into a PNE Chat production stack (compose.prod.yml). Run on the SERVER from the
# repository directory. THIS REPLACES the current database and attachments.
#
#   scripts/restore.sh backups/20261002T031500Z            # asks for confirmation
#   scripts/restore.sh backups/20261002T031500Z --yes      # no question (scripted drills)
#   scripts/restore.sh backups/20261002T031500Z --with-env # also puts env.backup back as .env (only when .env is missing or you pass --force-env)
#
# Encrypted backups (*.enc) need BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE, the same as when they were made.
#
# Typical disaster recovery on a NEW server: install Docker, clone the repository, copy the backup directory over, put the
# old .env in place (--with-env does it), `docker compose -f compose.prod.yml --env-file .env build`, then this script.
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
backup=""
assume_yes=false
with_env=false
force_env=false

while [ $# -gt 0 ]; do
    case "$1" in
        --yes | -y) assume_yes=true ;;
        --with-env) with_env=true ;;
        --force-env) force_env=true ;;
        -h | --help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; exit 2 ;;
        *) backup="$1" ;;
    esac
    shift
done

[ -n "$backup" ] || { echo "Usage: scripts/restore.sh <backup directory> [--yes] [--with-env]" >&2; exit 2; }
[ -d "$backup" ] || { echo "Not a directory: $backup" >&2; exit 1; }

if [ -z "${BACKUP_PASSPHRASE:-}" ] && [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
    BACKUP_PASSPHRASE="$(cat "$BACKUP_PASSPHRASE_FILE")"
fi

dc() { docker compose "${compose_files[@]}" --env-file "$ENV_FILE" "$@"; }
log() { echo "[restore $(date -u +%H:%M:%S)] $*"; }
die() { echo "[restore] ERROR: $*" >&2; exit 1; }

sha256_check() {
    if command -v sha256sum > /dev/null 2>&1; then sha256sum -c "$@"; else shasum -a 256 -c "$@"; fi
}

# part NAME: the path of NAME or NAME.enc inside the backup (empty if neither exists)
part() {
    if [ -f "$backup/$1.enc" ]; then echo "$backup/$1.enc"; elif [ -f "$backup/$1" ]; then echo "$backup/$1"; fi
}

# read_part PATH: the decrypted content on stdout
read_part() {
    case "$1" in
        *.enc)
            [ -n "${BACKUP_PASSPHRASE:-}" ] || die "$1 is encrypted: set BACKUP_PASSPHRASE or BACKUP_PASSPHRASE_FILE."
            BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$1"
            ;;
        *) cat "$1" ;;
    esac
}

mysql_dump="$(part mysql.sql.gz)"
storage_tar="$(part storage-app.tgz)"
openwa_tar="$(part openwa-data.tgz)"
env_backup="$(part env.backup)"
[ -n "$mysql_dump" ] || die "no mysql.sql.gz in $backup"
[ -n "$storage_tar" ] || die "no storage-app.tgz in $backup"

if [ -f "$backup/SHA256SUMS" ]; then
    log "verifying checksums ..."
    ( cd "$backup" && sha256_check SHA256SUMS > /dev/null ) || die "checksum mismatch: this backup is damaged."
fi

if [ "$with_env" = true ]; then
    [ -n "$env_backup" ] || die "this backup has no env.backup."
    if [ -f "$ENV_FILE" ] && [ "$force_env" = false ]; then
        die "$ENV_FILE already exists: add --force-env to replace it."
    fi
    ( umask 077; read_part "$env_backup" > "$ENV_FILE" )
    log "restored $ENV_FILE from the backup"
fi
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found: copy your .env here first (or use --with-env)."

if [ "$assume_yes" = false ]; then
    echo "This REPLACES the database and the attachments of the stack in $(pwd) with the backup $backup."
    read -r -p "Type RESTORE to continue: " answer
    [ "$answer" = "RESTORE" ] || { echo "Aborted."; exit 1; }
fi

log "stopping the application services (MySQL and Redis keep running) ..."
# the edge is `caddy` (Caddy with its own TLS) or `web` (behind the host's nginx): stop whichever this stack has
edge="$(dc config --services 2> /dev/null | grep -E '^(caddy|web)$' | tr '\n' ' ' || true)"
# shellcheck disable=SC2086
dc stop $edge app queue scheduler reverb nats-consumer > /dev/null 2>&1 || true
dc up -d --no-build --wait mysql redis > /dev/null

log "restoring MySQL ..."
read_part "$mysql_dump" | gzip -dc > /tmp/pnechat-restore.$$.sql
trap 'rm -f /tmp/pnechat-restore.$$.sql' EXIT
# Drop and recreate the database so tables that are not in the dump disappear as well (the application user owns it).
dc exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u"$MYSQL_USER" -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci"'
dc exec -T mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" --default-character-set=utf8mb4 "$MYSQL_DATABASE"' < /tmp/pnechat-restore.$$.sql
rm -f /tmp/pnechat-restore.$$.sql

log "restoring the storage volume ..."
read_part "$storage_tar" | dc run --rm --no-deps -T --entrypoint sh app -c 'rm -rf /var/www/html/storage/app && mkdir -p /var/www/html/storage/app && tar xzf - -C /var/www/html/storage'

if [ -n "$openwa_tar" ]; then
    project="$(dc config --format json 2> /dev/null | sed -n 's/^  "name": "\(.*\)",\{0,1\}$/\1/p' | head -n 1)"
    openwa_volume="$(docker volume ls --quiet --filter "label=com.docker.compose.project=${project}" --filter "label=com.docker.compose.volume=openwa-data" | head -n 1)"
    if [ -z "$openwa_volume" ]; then
        # the volume is created by compose when the whatsapp profile is first used: create it with the labels compose expects
        openwa_volume="${project}_openwa-data"
        docker volume create --label "com.docker.compose.project=${project}" --label "com.docker.compose.volume=openwa-data" "$openwa_volume" > /dev/null
    fi
    log "restoring the OpenWA volume ($openwa_volume) ..."
    dc stop openwa > /dev/null 2>&1 || true
    read_part "$openwa_tar" | dc run --rm --no-deps -T --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER -v "$openwa_volume":/openwa \
        --entrypoint sh app -c 'find /openwa -mindepth 1 -delete && tar xzf - -C /openwa'
fi

log "starting the stack ..."
if [ -n "$openwa_tar" ]; then
    # the gateway belongs to the `whatsapp` profile: start it even when COMPOSE_PROFILES in .env does not list it
    dc --profile whatsapp up -d --no-build > /dev/null
else
    dc up -d --no-build > /dev/null
fi
log "done. Check: docker compose ps  (in this directory)  and  curl -fsS https://<your domain>/up"
