<?php

/*
|--------------------------------------------------------------------------
| NATS / JetStream (pizzasys auth events)
|--------------------------------------------------------------------------
|
| Defaults for dev and tests, consumed by ConfigNatsSettingsProvider. In production the active auth
| environment's NATS block (auth_environments + settings) replaces them: track 2A rebinds
| NatsSettingsProvider to a database-backed implementation. Tunables below apply either way.
|
*/
return [

    /* Used by the config-backed settings provider only. */
    'enabled' => (bool) env('NATS_ENABLED', false),
    'url' => env('NATS_URL'),
    'token' => env('NATS_TOKEN'),
    'stream' => env('NATS_STREAM', 'AUTH_EVENTS'),
    'ensure_stream' => (bool) env('NATS_ENSURE_STREAM', true),
    'environment_key' => env('NATS_ENVIRONMENT_KEY', 'production'),
    /*
     * CA bundle the NATS server certificate is verified against (also for the active auth environment). Empty = the
     * system CA store. Verification (certificate AND host name) follows the environment's "verify TLS" switch; with it
     * on, a `tls://` address, or a `nats://` address to a public host, is refused unless TLS is really established.
     */
    'tls_ca_file' => env('NATS_TLS_CA_FILE'),
    /* Config-backed settings only (dev/tests): verify the server certificate. */
    'verify_tls' => (bool) env('NATS_VERIFY_TLS', true),

    /* Subjects the durable consumer (and an ensured stream) listen to. */
    'subject_filter' => 'auth.v1.>',

    /* Stream created when missing and `ensure_stream` is on (an existing stream is never altered). */
    'stream_max_age_days' => 30,

    'consumer' => [
        /* Durable name = <prefix>-<APP_ENV>-<--instance>. */
        'prefix' => 'pne-chat',
        'max_deliver' => 5,
        'batch' => 50,
        'expires_seconds' => 5,
        'ack_wait_seconds' => 30,
        /* `new`: a fresh durable ignores history (events are only fast-invalidation hints). */
        'deliver_policy' => 'new',
        /* Delay before redelivery after a failed handler, by delivery number (the last value repeats). */
        'nak_delays' => [2, 10, 30, 60],
    ],

    /* Poll the `auth.nats.restart` cache signal this often and reconnect when it changed. */
    'restart_poll_seconds' => 30,

    /* Re-run "ensure stream + consumer" this often so a wiped server/consumer heals itself. */
    'revalidate_seconds' => 300,

    /* While NATS is disabled/unconfigured the consumer process re-reads its settings this often. */
    'idle_poll_seconds' => 30,

    /* Reconnect backoff: exponential from initial to max, with jitter. */
    'backoff' => [
        'initial_seconds' => 1,
        'max_seconds' => 60,
    ],

    /* processed_events rows older than this are pruned (chat:auth:prune-events; the consumer also prunes hourly). */
    'retention_days' => 30,
    'prune_interval_seconds' => 3600,

    /* Metadata-only NDJSON of events that could not be processed (never contains payloads). */
    'dead_letter_path' => storage_path('logs/nats-dead-letter.ndjson'),
];
