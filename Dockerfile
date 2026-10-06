# syntax=docker/dockerfile:1.7
#
# PNE Chat production image. Two deliverable targets, built from one file so the static assets of the web tier are ALWAYS
# the ones that belong to the PHP code (no shared volume of public files):
#
#   docker build --target app -t pnechat-app .   php-fpm 8.4 + the application; also runs the queue worker, the scheduler,
#                                                 Reverb and the NATS consumer (same image, different command)
#   docker build --target web -t pnechat-web .   Caddy 2 + the built public/ directory (/build, the widget loader, sw.js ...); runs on its
#                                                 own with TLS, or behind the host's nginx (docs/deployment-vps-nginx.md)
#
# Stages: base (PHP + extensions) -> vendor (composer, no dev) -> frontend (pnpm + the Wayfinder PHP step + loader size check)
#         -> app -> web.  `docs/deployment-hostinger-kvm.md` explains how compose uses them.

ARG PHP_VERSION=8.4
ARG NODE_VERSION=24
ARG PNPM_VERSION=10.28.2
ARG CADDY_VERSION=2

FROM node:${NODE_VERSION}-bookworm-slim AS node-runtime

# ---------------------------------------------------------------------------------------------------------------------
# base-build: PHP-FPM on Debian bookworm with everything the application needs, then the compiler toolchain is removed again
# ---------------------------------------------------------------------------------------------------------------------
FROM php:${PHP_VERSION}-fpm-bookworm AS base-build

ENV DEBIAN_FRONTEND=noninteractive

# curl: container health checks. libfcgi-bin: `cgi-fcgi`, the php-fpm health probe. procps: `pgrep` for the worker probes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl libfcgi-bin procps tzdata \
    && rm -rf /var/lib/apt/lists/*

# pdo_mysql          MySQL
# redis              phpredis (REDIS_CLIENT=phpredis; presence, cache, queue, sessions)
# pcntl              graceful shutdown of the queue worker, Reverb and the NATS consumer
# intl               punycode of the widget domain whitelist
# gd                 the image sanitiser behind chat attachments and WhatsApp media (Intervention Image, GD driver)
# exif, bcmath, gmp  image metadata, web-push (VAPID) maths
# zip, sockets       framework / Reverb
# opcache            production performance
# uv                 libuv event loop for Reverb: WITHOUT it Reverb falls back to stream_select() and exits at about 1000 sockets
COPY --from=ghcr.io/mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/
RUN install-php-extensions pdo_mysql redis pcntl intl gd exif bcmath gmp zip sockets opcache uv

# php.ini-production + our overrides (docker/php/pne.ini); the pool replaces the image's www.conf
RUN cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"
COPY docker/php/pne.ini "$PHP_INI_DIR/conf.d/zz-pne.ini"
COPY docker/php/www.conf /usr/local/etc/php-fpm.d/www.conf
# docker.conf / zz-docker.conf (from the base image) log every request, set `daemonize = no` and `listen = 9000`; our pool file sets the socket instead.
RUN rm -f /usr/local/etc/php-fpm.d/docker.conf /usr/local/etc/php-fpm.d/zz-docker.conf \
    && printf '[global]\ndaemonize = no\nerror_log = /proc/self/fd/2\n' > /usr/local/etc/php-fpm.d/zz-pne-global.conf

# The official image keeps a full compiler toolchain for `docker-php-ext-install`. Every extension is built by now, so remove it
# (about 270 MB, and nothing to compile an exploit with inside a running container); the runtime libraries stay.
RUN set -eux; \
    toolchain="$PHPIZE_DEPS $(apt-mark showmanual | grep -E '^(binutils.*|cpp|cpp-[0-9]+|g\+\+-[0-9]+|gcc-[0-9]+|libc6-dev|libc-dev-bin|libcrypt-dev|libgcc-[0-9]+-dev|libstdc\+\+-[0-9]+-dev|linux-libc-dev|libtirpc-dev|libnsl-dev|rpcsvc-proto|m4|patch|perl|perl-modules.*|libperl.*|libdpkg-perl|libasan.*|libtsan.*|libubsan.*|liblsan.*|libhwasan.*|libitm.*|libatomic.*|libcc1-0|libgprofng0|libisl.*|libmpc3|libmpfr6|libctf.*|libbinutils|pkgconf.*|libpkgconf3)$' | tr '\n' ' ')"; \
    apt-get purge -y --auto-remove $toolchain; \
    docker-php-source delete; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/* /usr/src/php.tar.xz /usr/local/lib/php/test /usr/local/lib/php/doc /tmp/* /root/.cache; \
    php -m | grep -qx uv; php -m | grep -qx gd; php -m | grep -qx redis

# Flatten: one layer without the history of the toolchain (a plain purge would leave the 270 MB in the layers below).
FROM scratch AS base
COPY --from=base-build / /
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    PHP_INI_DIR=/usr/local/etc/php \
    TZ=UTC \
    COMPOSER_ALLOW_SUPERUSER=1 \
    COMPOSER_NO_INTERACTION=1 \
    FPM_MAX_CHILDREN=16 \
    FPM_START_SERVERS=4 \
    FPM_MIN_SPARE_SERVERS=2 \
    FPM_MAX_SPARE_SERVERS=8
STOPSIGNAL SIGQUIT
WORKDIR /var/www/html
CMD ["php-fpm"]

# ---------------------------------------------------------------------------------------------------------------------
# vendor: composer install without dev packages (Scribe, Boost, Pint, PHPUnit ... stay out)
# ---------------------------------------------------------------------------------------------------------------------
FROM base AS vendor
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
# --no-scripts: the post-autoload hooks boot the application, which does not exist yet at this point
RUN --mount=type=cache,target=/root/.composer/cache \
    composer install --no-dev --no-scripts --no-autoloader --prefer-dist --no-progress
COPY app ./app
COPY database ./database
RUN composer dump-autoload --no-dev --optimize --classmap-authoritative --no-scripts \
    # 113 MB of IDE stubs that only roave/better-reflection (the dev-time TypeScript generator) would read; the map file stays, Composer autoloads it
    && find vendor/jetbrains/phpstorm-stubs -mindepth 1 -maxdepth 1 ! -name PhpStormStubsMap.php -exec rm -rf {} +

# ---------------------------------------------------------------------------------------------------------------------
# frontend: the dashboard bundle (public/build) and the widget loader (public/widget/v1/loader.js)
# `vp build` runs `php artisan wayfinder:generate --with-form` (the Wayfinder vite plugin), so this stage needs PHP + vendor too.
# ---------------------------------------------------------------------------------------------------------------------
FROM base AS frontend
ARG PNPM_VERSION
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && npm install -g pnpm@${PNPM_VERSION} --no-audit --no-fund
WORKDIR /app
# The lockfile of record is pnpm-lock.yaml (package-lock.json in the repository is a stale leftover of phase 0 and is ignored).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY --from=vendor /app/vendor ./vendor
COPY . .
# the artisan boot of the Wayfinder step needs writable framework directories and an application key (throwaway, build stage only)
RUN mkdir -p storage/app/private storage/app/public storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs bootstrap/cache
ENV APP_ENV=production \
    APP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
    BROADCAST_CONNECTION=null \
    CACHE_STORE=file \
    SESSION_DRIVER=file \
    QUEUE_CONNECTION=sync
RUN pnpm run build \
    && pnpm run build:widget \
    && pnpm run size

# ---------------------------------------------------------------------------------------------------------------------
# app: the runtime image (php-fpm, queue worker, scheduler, Reverb, NATS consumer)
# ---------------------------------------------------------------------------------------------------------------------
FROM base AS app
WORKDIR /var/www/html

# Code is owned by root and read-only for the runtime user: only storage/ (a volume) and bootstrap/cache (a tmpfs) are writable.
COPY --from=vendor /app/vendor ./vendor
COPY app ./app
COPY bootstrap/app.php bootstrap/providers.php ./bootstrap/
COPY config ./config
COPY database ./database
COPY lang ./lang
COPY routes ./routes
COPY resources/views ./resources/views
COPY artisan composer.json composer.lock ./
COPY public ./public
COPY --from=frontend /app/public/build ./public/build
COPY --from=frontend /app/public/widget ./public/widget

RUN mkdir -p storage/app/private storage/app/public storage/framework/cache/data storage/framework/sessions storage/framework/views storage/logs bootstrap/cache /run/php \
    && chown -R www-data:www-data storage bootstrap/cache /run/php \
    && chmod 755 artisan \
    && php artisan package:discover --ansi

COPY docker/entrypoint.sh /usr/local/bin/pne-entrypoint
COPY docker/healthcheck.sh /usr/local/bin/pne-healthcheck
RUN chmod 755 /usr/local/bin/pne-entrypoint /usr/local/bin/pne-healthcheck

# HOME: tinker (psysh) wants a writable home, the root file system is read-only at runtime
ENV APP_ENV=production \
    LOG_CHANNEL=stderr \
    HOME=/tmp

USER www-data
ENTRYPOINT ["pne-entrypoint"]
CMD ["php-fpm"]

# ---------------------------------------------------------------------------------------------------------------------
# web: Caddy with the public/ directory of THIS build baked in. One image, two ways to run it:
#   Caddyfile        (the default command) Caddy terminates TLS itself, automatic Let's Encrypt          compose.prod.yml  `caddy`
#   Caddyfile.proxy  plain HTTP behind nginx / certbot on the host (`caddy run --config /etc/caddy/Caddyfile.proxy`)  compose.nginx.yml `web`
# Both import routes.caddy, so the routing of the two modes cannot drift apart.
# ---------------------------------------------------------------------------------------------------------------------
FROM caddy:${CADDY_VERSION}-alpine AS web
COPY docker/caddy/routes.caddy docker/caddy/Caddyfile docker/caddy/Caddyfile.proxy /etc/caddy/
COPY --from=app /var/www/html/public /srv/public
