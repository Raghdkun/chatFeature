<?php

/*
|--------------------------------------------------------------------------
| Native staff sign-in (`POST /api/v1/auth/token`, docs/mobile-readiness.md)
|--------------------------------------------------------------------------
| The one unauthenticated management endpoint: it hands out a Sanctum bearer token for a password. Everything here only ever makes it
| tighter or looser around that; the sign-in attempts themselves are throttled by the `login` limiter (`chat.login_throttle`), the SAME
| budget the dashboard's login uses.
*/
return [
    /*
     * Live bearer tokens (signed-in devices) per staff member. A sign-in over the limit revokes the token that was used least recently
     * (never the new one); in the external auth mode that also ends its portal session.
     */
    'max_tokens_per_user' => 10,

    /* Largest body (bytes) the sign-in and second-factor calls read: a credential is a few hundred bytes. Over it: 413. */
    'max_body_bytes' => 8192,

    /*
     * The second-factor step (`POST /api/v1/auth/token/two-factor`). A challenge lives `challenge_minutes`, works once and burns after
     * `challenge_attempts` wrong codes. Wrong codes are also counted per account (a new password-verified challenge does not give a fresh
     * budget): `per_user_per_minute` and `per_user_per_hour`; `per_ip` is every call, right or wrong, from one client address.
     */
    'two_factor' => [
        'challenge_minutes' => 5,
        'challenge_attempts' => 5,
        'per_user_per_minute' => 5,
        'per_user_per_hour' => 20,
        'per_ip' => 30,
    ],

    /*
     * Failed sign-ins written to `audit_logs` per minute, for the whole installation. Past it the failures are only counted and ONE
     * `auth.token.failure_flood` row a minute says so: a credential-stuffing run must not turn into a flood of database writes.
     */
    'audit_failures_per_minute' => 120,
];
