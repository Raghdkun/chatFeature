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

    /* Signed visitor identities (HS256 JWT minted by the host website). */
    'identity' => [
        /* `exp` may lie at most this many seconds ahead; tokens living longer are refused. */
        'max_lifetime_seconds' => 300,
    ],
];
