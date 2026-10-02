#!/bin/sh
# Entrypoint of the PNE Chat application image (php-fpm, queue, scheduler, reverb and nats-consumer all use it).
# It only does safe, idempotent things. It NEVER runs migrations and NEVER installs: the setup wizard (or `chat:install`)
# owns the first migration, and an upgrade is an explicit `php artisan migrate --force` (docs/deployment-hostinger-kvm.md).
set -eu

cd /var/www/html

STATE_DIR="${INSTALL_STATE_DIR:-/var/www/html/storage/app}"
LOCK_FILE="$STATE_DIR/installed.lock"

# A fresh named volume is filled from the image, but a restored or bind-mounted one may be empty.
for dir in app/private app/public framework/cache/data framework/sessions framework/views logs; do
    mkdir -p "storage/$dir" 2>/dev/null || true
done

# Long-running workers must not start before the wizard has finished: until `installed.lock` exists the application forces
# the file/sync/null drivers, so a queue worker would idle on the sync driver, the scheduler would hit an empty database and
# Reverb would not know the saved application URL yet. They simply wait (healthy, doing nothing) and start by themselves.
if [ "${CHAT_WAIT_FOR_INSTALL:-false}" = "true" ] && [ "${APP_INSTALLED:-}" != "true" ] && [ ! -f "$LOCK_FILE" ]; then
    echo "[entrypoint] Not installed yet (no $LOCK_FILE): waiting for the setup wizard to finish..."
    while [ ! -f "$LOCK_FILE" ]; do
        sleep 5
    done
    echo "[entrypoint] Installation detected, starting."
fi

installed=false
if [ "${APP_INSTALLED:-}" = "true" ] || [ -f "$LOCK_FILE" ]; then
    installed=true
fi

# Cache the configuration, the routes and the events once per container start (bootstrap/cache is a tmpfs, nothing is baked into
# the image: the environment is only final now). NEVER before the installation: until installed.lock exists the application forces
# the file / sync / null drivers at boot, and `config:cache` would freeze exactly those. So php-fpm of a fresh install runs uncached
# until its next restart (the workers wait for the lock and start cached). Switch it off with APP_OPTIMIZE=false; a failure is not
# fatal, the application simply runs uncached.
if [ "${APP_OPTIMIZE:-true}" = "true" ] && [ "$installed" = "true" ]; then
    php artisan config:cache --no-interaction >/dev/null 2>&1 || echo "[entrypoint] config:cache failed, continuing uncached" >&2
    php artisan route:cache --no-interaction >/dev/null 2>&1 || echo "[entrypoint] route:cache failed, continuing uncached" >&2
    php artisan event:cache --no-interaction >/dev/null 2>&1 || true
fi

if [ "${CHAT_ROLE:-}" = "app" ] && [ "$installed" = "false" ]; then
    echo "[entrypoint] Not installed yet: open ${APP_URL:-https://<your domain>}/setup and enter the SETUP_TOKEN from your .env file."
fi

exec "$@"
