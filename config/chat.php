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
    ],

    /* Signed visitor identities (HS256 JWT minted by the host website). */
    'identity' => [
        /* `exp` may lie at most this many seconds ahead; tokens living longer are refused. */
        'max_lifetime_seconds' => 300,
    ],
];
