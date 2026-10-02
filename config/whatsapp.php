<?php

/*
|--------------------------------------------------------------------------
| WhatsApp (OpenWA) runtime constants (P6)
|--------------------------------------------------------------------------
| What an administrator can change lives in the `whatsapp.*` SETTINGS (docs/contracts/whatsapp-data-p6.md); these are the numbers
| the code needs that are not worth a settings screen. Every value has a safe default: nothing here has to be set.
*/
return [

    /*
     * Calls to the OpenWA gateway (seconds). `connect` is the TCP connect, the others the whole call. Starting a session BLOCKS at
     * OpenWA until the engine waits for a scan (recorded: 6-25 s, a stuck engine answers 504 after its own timeout); a send simulates
     * typing first (up to 5 s).
     */
    'http' => [
        'connect_timeout' => 3,
        'timeout' => 15,
        'qr_timeout' => 20,
        'stop_timeout' => 30,
        'start_timeout' => 90,
        'send_timeout' => 30,
        'media_timeout' => 30,
    ],

    /*
     * The inbound webhook (`POST /webhooks/openwa/{session}`).
     * - max_body_bytes: bigger bodies are refused with 413 before the signature is even looked at (OpenWA never sends more than
     *   its own WEBHOOK_MAX_PAYLOAD_BYTES, 1 MiB by default).
     * - rate_limits: per minute, per client network and per session (`wa-webhook`).
     * - redeliver_after_seconds: a stored delivery whose job has not completed after this long is queued again when OpenWA
     *   repeats it (the queue lost the job).
     * - tries / backoff: attempts of the queued job and the seconds before each next one.
     * - replay (`whatsapp:replay-deliveries`, every 5 minutes): a delivery OpenWA was answered for but whose job was lost (no outcome
     *   after `stuck_after_seconds`) or that ended `failed` (retried after `failed_after_seconds` x the replays used) is queued again, at
     *   most `max` times per delivery, `batch` per run. The raw body is kept on the ledger row for that.
     * - session_lock_wait_seconds: the events of one session are applied one at a time (their order is the point); a delivery waits this
     *   long for its turn and is retried by its job when the turn does not come.
     */
    'webhook' => [
        'max_body_bytes' => 1048576,
        'session_lock_wait_seconds' => 10,
        // Per minute. `per_session`: one session's deliveries from one client network (OpenWA calls from one address for every session, so
        // the sessions must not share a budget); `per_network`: the ceiling for everything one client network sends to any session.
        'rate_limits' => [
            'per_network' => (int) env('WHATSAPP_WEBHOOK_RATE_PER_NETWORK', 6000),
            'per_session' => (int) env('WHATSAPP_WEBHOOK_RATE_PER_SESSION', 3000),
        ],
        'redeliver_after_seconds' => 300,
        'tries' => 5,
        'backoff' => [5, 20, 60, 180],
        'ack_retry_seconds' => [5, 20],
        'replay' => ['stuck_after_seconds' => 120, 'failed_after_seconds' => 300, 'max' => 5, 'batch' => 200],
    ],

    /* The events every webhook is registered for (OpenWA delivers nothing else to us). */
    'webhook_events' => [
        'message.received',
        'message.sent',
        'message.ack',
        'message.failed',
        'session.status',
        'session.qr',
        'session.authenticated',
        'session.disconnected',
        'session.reconnect_loop',
    ],

    /*
     * Hand-off (`POST /public/widgets/{key}/whatsapp-handoff`). Visitors who ask again get their live ticket back, so these only
     * bound a script. Per minute, on top of the public network limits (`chat.rate_limits`).
     */
    'handoff' => [
        'rate_limits' => ['per_visitor' => 6, 'per_network' => 20, 'per_widget_network' => 10, 'per_widget' => 120],
        // Caps on LIVE (unconsumed, unexpired) tickets, which a script cannot dodge by fetching a new visitor token for every request.
        'max_live_per_widget_network' => 30,
        'max_live_per_widget' => 500,
    ],

    /* How many of a chat's first inbound messages are searched for a hand-off code (a customer rarely needs more than the first). */
    'linker' => [
        'max_inbound_messages' => 5,
        'max_candidates_per_message' => 5,
    ],

    /*
     * Inbound images: the private disk, a pixel limit per side, and how long a message waits for OpenWA's copy of a large image.
     * Every other media type is recorded as a typed row without a file (P6-D7).
     */
    'media' => [
        'disk' => env('WHATSAPP_MEDIA_DISK', 'local'),
        'max_dimension' => 4096,
        'fetch_tries' => 4,
        'fetch_backoff' => [10, 60, 300],
    ],

    /*
     * Outbound sends (`SendWhatsAppMessage`).
     * - max_defer_seconds: an OpenWA `SEND_PACING_LIMITED` that clears within this long is waited for; a longer one fails the message.
     * - retry_for_minutes: how long a send that cannot reach OpenWA (or hits the plain throttler) is retried before it is failed.
     * - inline_wait_ms: on the `sync` queue (no way to release a job) the worker sleeps for the pacing slot, at most this long.
     * - unconfirmed_after_minutes: a reply OpenWA never confirmed (the request was sent, the answer never arrived) waits this long
     *   for the `message.sent` webhook before the reconciliation fails it.
     */
    'send' => [
        'max_defer_seconds' => 300,
        'retry_for_minutes' => 20,
        'inline_wait_ms' => 10000,
        'unconfirmed_after_minutes' => 30,
    ],

    /* Rate limits of the admin API on top of `chat.rate_limits.staff_api_user`: the QR poll and the connection test, per minute per staff member. */
    'admin_rate_limits' => ['qr' => 60, 'test' => 10],

    /* `whatsapp:prune`: how long a webhook ledger row, an expired unconsumed ticket and an unreferenced media file are kept. */
    'prune' => [
        'deliveries_days' => 30,
        'tickets_days' => 1,
        'media_hours' => 24,
    ],
];
