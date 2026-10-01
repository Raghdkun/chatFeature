<?php

/*
|--------------------------------------------------------------------------
| PNE Chat application constants
|--------------------------------------------------------------------------
*/
return [

    /* Locales the UI ships translations for (lang/<locale>.json). */
    'locales' => ['en', 'ar'],

    /*
     * Reverse proxies whose X-Forwarded-* headers are trusted (comma-separated addresses/CIDRs, or `*`).
     * Empty = trust nothing. Applied in AppServiceProvider (read from config, so it survives `config:cache`).
     */
    'trusted_proxies' => env('TRUSTED_PROXIES'),

    /*
     * The app calls the auth portal (and its NATS server) at an address an administrator types in, with a bearer token.
     * Such addresses must point at a PUBLIC host: loopback, private (10.x, 172.16-31.x, 192.168.x, fc00::/7), CGNAT and
     * link-local targets are refused (and the cloud metadata addresses always are). Set this to true ONLY when the
     * portal really lives on a private network, for example a Docker network or a VPN. APP_ENV=local always allows it.
     */
    'portal_allow_private_hosts' => (bool) env('PORTAL_ALLOW_PRIVATE_HOSTS', false),

    /*
     * Sign-in attempts a minute (the `login` rate limiter): per email + client address, per client address (one
     * address spraying many emails) and per email across every address (one account attacked from many). A request over
     * any of them is refused with 429.
     */
    'login_throttle' => [
        'per_email_and_ip' => 5,
        'per_ip' => 30,
        'per_email' => 10,
    ],

    /* Locales rendered right-to-left (drives the `direction` shared prop and <html dir>). */
    'rtl_locales' => ['ar', 'he', 'fa', 'ur'],

    /*
     * Rate limits of the public widget endpoints (loader script, iframe pages, config/availability API), per minute.
     * - public_ip: per client network (IPv4 address / IPv6 /64), across ALL widget keys; evaluated before anything else.
     * - public_unknown_keys: lookups of keys that do not exist (or are disabled) per client network, then 429.
     * - public_widget_ip: per client network and widget key; only requests that passed the origin check count.
     * - public_widget_origin: per widget key and allowed origin; only requests that passed the origin check count.
     */
    'rate_limits' => [
        'public_ip' => 600,
        'public_unknown_keys' => 60,
        'public_widget_ip' => 300,
        'public_widget_origin' => 6000,

        /*
         * Live chat (P4), per minute. Visitor limits key on the bearer token (or the client network for the unauthenticated
         * session endpoint); the staff limit keys on the signed-in user.
         * - public_session_ip / public_session_widget: POST /public/widgets/{key}/sessions per client network / per network + widget key.
         * - public_message_session: POST messages per visitor session. public_chat_session: every other visitor call (reads, receipts, typing ...).
         * - public_chat_ip: every visitor call per client network (a shared office NAT needs room).
         * - public_upload_session: image uploads per visitor session. public_offline_ip / public_offline_session: offline tickets.
         * - public_visitor_ip: EVERY visitor call per client network, counted BEFORE the token is looked up (`public-network`): random
         *   bearer tokens each cost an indexed read, so they must be throttled before the lookup.
         * - start_per_widget_network / start_per_widget: starting a live chat (`POST /public/conversations`, `public-message`) per
         *   widget + client network and per widget overall. offline_per_widget_network / offline_per_widget: the same for offline tickets
         *   (`public-offline`). The Origin check is forgeable by a non-browser client, so these budgets are the anti-automation
         *   floor (a captcha / proof-of-work hook is planned for P7). A shared office NAT that needs more raises the first one.
         * - staff_api_user: management chat calls per staff member.
         */
        'public_session_ip' => 60,
        'public_session_widget' => 30,
        'public_message_session' => 30,
        'public_chat_session' => 240,
        'public_chat_ip' => 600,
        'public_upload_session' => 10,
        'public_offline_ip' => 10,
        'public_offline_session' => 3,
        'public_visitor_ip' => 600,
        'start_per_widget_network' => 3,
        'start_per_widget' => 120,
        'offline_per_widget_network' => 3,
        'offline_per_widget' => 120,
        'staff_api_user' => 600,
    ],

    /*
     * Chat start guards (not per-minute limiters; see also rate_limits.start_*).
     * - cancel_cooldown_seconds: after a visitor cancels a queued chat they cannot start another for this long (429 + Retry-After):
     *   start / cancel loops each fan an offer out to every agent.
     * - max_queued_per_network: live chats waiting for an agent at once from one client network on one widget (429 above it).
     */
    'cancel_cooldown_seconds' => 10,
    'max_queued_per_network' => 3,

    /* Disk that holds chat attachments (re-encoded images, random paths). Private: files are only served through signed URLs. */
    'attachments_disk' => env('CHAT_ATTACHMENTS_DISK', 'local'),

    /* Signed visitor identities (HS256 JWT minted by the host website). */
    'identity' => [
        /* `exp` may lie at most this many seconds ahead; tokens living longer are refused. */
        'max_lifetime_seconds' => 300,
    ],
];
