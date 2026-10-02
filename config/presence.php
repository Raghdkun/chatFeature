<?php

/*
|--------------------------------------------------------------------------
| Agent presence (P5)
|--------------------------------------------------------------------------
| Where a staff member's live status is kept and when it changes by itself. docs/realtime.md ("Presence") has the rules.
*/
return [

    /*
     * `redis`: the live state sits in Redis (one hash per user plus a sorted set of last heartbeats), so a heartbeat costs no SQL; the
     * `agent_presence` table is only a mirror written when an agent's EFFECTIVE status changes. `database`: the table itself is the
     * store (every heartbeat is one UPDATE): fine for development and small installs. Default: `redis` when the cache, the queue or the
     * sessions already run on Redis, else `database`. A Redis outage falls back to the database store (see `failure_cooldown_seconds`).
     */
    'store' => env('PRESENCE_STORE', in_array('redis', [
        env('CACHE_STORE', 'database'),
        env('QUEUE_CONNECTION', 'database'),
        env('SESSION_DRIVER', 'database'),
    ], true) ? 'redis' : 'database'),

    /*
     * No heartbeat for this long = the agent is offline (a closed tab, a sleeping laptop). The dashboard beats every 30 s and browsers
     * throttle a background tab to about once a minute, so keep this above 60. The Redis record itself lives twice as long (the
     * heartbeat of a tab that was silent a little longer than the window still brings the agent back; later ones do not).
     */
    'heartbeat_window_seconds' => (int) env('PRESENCE_HEARTBEAT_WINDOW', 90),

    /*
     * An agent whose dashboard tabs have all reported `visible=false` for this many minutes is `away` until a visible heartbeat; routing
     * offers chats to `away` agents from the second wave on. 0 turns auto-away off. Agents who pinned a status by hand are never moved.
     */
    'auto_away_minutes' => (int) env('PRESENCE_AUTO_AWAY_MINUTES', 5),

    'redis' => [
        /* A connection of `database.redis.*`. */
        'connection' => env('PRESENCE_REDIS_CONNECTION', 'default'),
        /* Keys are `{prefix}{userId}` (hash) and `{prefix}alive` (sorted set). Laravel's own Redis prefix is applied on top. */
        'prefix' => env('PRESENCE_REDIS_PREFIX', 'presence:'),
    ],

    /*
     * After a Redis failure the database store serves everything for this long before Redis is tried again. Every request boots a fresh
     * application (PHP-FPM, `artisan serve`), so the cooldown is remembered in this cache store, which must not depend on Redis: the file
     * store by default (the processes of one server share its disk).
     */
    'failure_cooldown_seconds' => 15,
    'failure_store' => env('PRESENCE_FAILURE_STORE', 'file'),

    /* How many users `chat:presence-sweep` looks at per step. */
    'sweep_batch_size' => 200,
];
