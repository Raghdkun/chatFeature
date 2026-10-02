#!/usr/bin/env bash
# Prepares the production `.env` of compose.prod.yml in two steps (idempotent, never overwrites a secret that exists).
#
#   scripts/init-env.sh --domain chat.example.com --email you@example.com
#       Step 1: copies .env.production.example to .env (mode 600) and fills in the domain (APP_DOMAIN, APP_URL, REVERB_HOST), the e-mail
#       address and fresh random passwords for MySQL, Redis and the OpenWA key pepper. Needs only `openssl`.
#
#   docker compose -f compose.prod.yml --env-file .env build
#
#   scripts/init-env.sh --secrets
#       Step 2: asks the freshly built application image (`php artisan chat:bootstrap-secrets`) for the secrets only PHP can
#       make: APP_KEY, the Reverb app id/key/secret, the VAPID key pair and the one-time SETUP_TOKEN. Existing values are kept.
#
# Local test with Caddy's own CA:  scripts/init-env.sh --domain localhost --email internal
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE="${ENV_FILE:-.env}"
EXAMPLE_FILE=".env.production.example"
domain=""
email=""
secrets_only=false

usage() {
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --domain) domain="${2:?--domain needs a value}"; shift 2 ;;
        --email) email="${2:?--email needs a value}"; shift 2 ;;
        --secrets) secrets_only=true; shift ;;
        -h | --help) usage 0 ;;
        *) echo "Unknown option: $1" >&2; usage 2 ;;
    esac
done

# set_value KEY VALUE: replaces the line `KEY=...` (only if the current value is empty unless FORCE=1) or appends it.
set_value() {
    local key="$1" value="$2" tmp
    tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    awk -v key="$key" -v value="$value" 'BEGIN { done = 0 }
        $0 ~ "^" key "=" { if (!done) { print key "=" value; done = 1 } next }
        { print }
        END { if (!done) print key "=" value }' "$ENV_FILE" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$ENV_FILE"
}

current_value() {
    grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- || true
}

# set_secret KEY: a new random value, but only while the key is empty.
set_secret() {
    local key="$1" bytes="${2:-24}"
    if [ -z "$(current_value "$key")" ]; then
        set_value "$key" "$(openssl rand -hex "$bytes")"
        echo "  generated $key"
    fi
}

if [ "$secrets_only" = false ]; then
    if [ -z "$domain" ] || [ -z "$email" ]; then
        echo "Both --domain and --email are required (use --email internal with --domain localhost for a local test)." >&2
        usage 2
    fi

    if [ ! -f "$ENV_FILE" ]; then
        umask 077
        cp "$EXAMPLE_FILE" "$ENV_FILE"
        chmod 600 "$ENV_FILE"
        echo "Created $ENV_FILE from $EXAMPLE_FILE"
    else
        echo "$ENV_FILE exists: the domain and e-mail you passed are set again; existing secrets are never overwritten."
    fi

    set_value APP_DOMAIN "$domain"
    set_value CADDY_TLS "$email"
    set_value APP_URL "https://$domain"
    set_value REVERB_HOST "$domain"
    if [ "$email" != "internal" ]; then
        set_value VAPID_SUBJECT "mailto:$email"
        set_value MAIL_FROM_ADDRESS "chat@$domain"
    fi
    set_secret DB_PASSWORD 24
    set_secret REDIS_PASSWORD 24
    set_secret OPENWA_API_KEY_PEPPER 32

    cat <<EOF

Next:
  1. Check $ENV_FILE (mail settings, memory limits).
  2. docker compose -f compose.prod.yml --env-file $ENV_FILE build
  3. scripts/init-env.sh --secrets
EOF
    exit 0
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "$ENV_FILE does not exist: run step 1 first (scripts/init-env.sh --domain ... --email ...)." >&2
    exit 1
fi

image="$(grep -E '^PNE_IMAGE_APP=' "$ENV_FILE" | cut -d= -f2- || true)"
image="${image:-pnechat-app}:$(grep -E '^PNE_TAG=' "$ENV_FILE" | cut -d= -f2- || true)"
case "$image" in *: ) image="${image}latest" ;; esac

if ! docker image inspect "$image" > /dev/null 2>&1; then
    echo "The image $image does not exist yet: run 'docker compose -f compose.prod.yml --env-file $ENV_FILE build' first." >&2
    exit 1
fi

# The container writes the file as the calling user (so the 600 mode and the owner stay yours): mount the directory, not the file.
docker run --rm --user "$(id -u):$(id -g)" --entrypoint php -v "$PWD:/work" -w /var/www/html "$image" \
    artisan chat:bootstrap-secrets --env-file=/work/"$ENV_FILE" --no-interaction

chmod 600 "$ENV_FILE"
echo
echo "Keep a copy of $ENV_FILE in your password manager: without APP_KEY the encrypted settings in the database cannot be read."
