#!/bin/sh
# Container health probes of the PNE Chat application image: `pne-healthcheck <fpm|reverb|worker> [process pattern]`.
# A worker that is still waiting for the setup wizard (CHAT_WAIT_FOR_INSTALL, see entrypoint.sh) counts as healthy: it is
# supposed to be idle until installed.lock exists.
set -u

LOCK_FILE="${INSTALL_STATE_DIR:-/var/www/html/storage/app}/installed.lock"

waiting_for_install() {
    [ "${CHAT_WAIT_FOR_INSTALL:-false}" = "true" ] && [ "${APP_INSTALLED:-}" != "true" ] && [ ! -f "$LOCK_FILE" ]
}

case "${1:-}" in
    fpm)
        # FastCGI ping answered by the FPM master itself (no application code involved).
        SCRIPT_NAME=/ping SCRIPT_FILENAME=/ping REQUEST_METHOD=GET \
            cgi-fcgi -bind -connect /run/php/php-fpm.sock 2>/dev/null | grep -q pong
        ;;
    reverb)
        waiting_for_install && exit 0
        curl -fsS --max-time 3 http://127.0.0.1:8080/up >/dev/null 2>&1
        ;;
    worker)
        waiting_for_install && exit 0
        pgrep -f "${2:?process pattern required}" >/dev/null 2>&1
        ;;
    *)
        echo "usage: pne-healthcheck fpm|reverb|worker <pattern>" >&2
        exit 2
        ;;
esac
