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
];
