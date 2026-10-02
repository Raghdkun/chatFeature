<?php

/*
 * `reverb` only counts as configured with its credentials and host. Without them the broadcaster would be built with `null`
 * arguments (a TypeError that takes every request and artisan command down) or publish to Pusher's default host, so the
 * connection falls back to `null`: the chat keeps working over REST, only the live push is off (the visitor panel and the
 * dashboard fall back to polling / refetching). Before the install lock exists InstallAwareConfigProvider forces `null` anyway.
 */
$requestedConnection = (string) (env('BROADCAST_CONNECTION') ?: 'null'); // env() turns the string "null" into PHP null
$reverbConfigured = filled(env('REVERB_APP_KEY')) && filled(env('REVERB_APP_SECRET')) && filled(env('REVERB_APP_ID')) && filled(env('REVERB_HOST'));

/* Where THIS application publishes events to (server to server). Defaults to the public address; behind Caddy / in Docker set REVERB_PUBLISH_* to the internal one. */
$publishScheme = (string) (env('REVERB_PUBLISH_SCHEME') ?: env('REVERB_SCHEME') ?: 'https');

return [

    /*
    |--------------------------------------------------------------------------
    | Default Broadcaster
    |--------------------------------------------------------------------------
    |
    | This option controls the default broadcaster that will be used by the
    | framework when an event needs to be broadcast. You may set this to
    | any of the connections defined in the "connections" array below.
    |
    | Supported: "reverb", "pusher", "ably", "mercure", "redis", "log", "null"
    |
    */

    'default' => $requestedConnection === 'reverb' && ! $reverbConfigured ? 'null' : $requestedConnection,

    /*
    |--------------------------------------------------------------------------
    | Broadcast Connections
    |--------------------------------------------------------------------------
    |
    | Here you may define all of the broadcast connections that will be used
    | to broadcast events to other systems or over WebSockets. Samples of
    | each available type of connection are provided inside this array.
    |
    */

    'connections' => [

        'reverb' => [
            'driver' => 'reverb',
            'key' => env('REVERB_APP_KEY', ''),
            'secret' => env('REVERB_APP_SECRET', ''),
            'app_id' => env('REVERB_APP_ID', ''),
            'options' => [
                'host' => (string) (env('REVERB_PUBLISH_HOST') ?: env('REVERB_HOST') ?: 'localhost'),
                'port' => (int) (env('REVERB_PUBLISH_PORT') ?: env('REVERB_PORT') ?: 443),
                'scheme' => $publishScheme,
                'useTLS' => $publishScheme === 'https',
            ],
            'client_options' => [
                // Guzzle client options: https://docs.guzzlephp.org/en/stable/request-options.html
                // `message.created` is published inside the request that stored the message: a Reverb that does not answer must
                // cost seconds at most, never the default 10 s connect / 30 s total timeout.
                'connect_timeout' => (float) env('REVERB_PUBLISH_CONNECT_TIMEOUT', 2),
                'timeout' => (float) env('REVERB_PUBLISH_TIMEOUT', 5),
            ],
        ],

        'pusher' => [
            'driver' => 'pusher',
            'key' => env('PUSHER_APP_KEY'),
            'secret' => env('PUSHER_APP_SECRET'),
            'app_id' => env('PUSHER_APP_ID'),
            'options' => [
                'cluster' => env('PUSHER_APP_CLUSTER'),
                'host' => env('PUSHER_HOST') ?: 'api-'.env('PUSHER_APP_CLUSTER', 'mt1').'.pusher.com',
                'port' => env('PUSHER_PORT', 443),
                'scheme' => env('PUSHER_SCHEME', 'https'),
                'encrypted' => true,
                'useTLS' => env('PUSHER_SCHEME', 'https') === 'https',
            ],
            'client_options' => [
                // Guzzle client options: https://docs.guzzlephp.org/en/stable/request-options.html
            ],
        ],

        'ably' => [
            'driver' => 'ably',
            'key' => env('ABLY_KEY'),
        ],

        'mercure' => [
            'driver' => 'mercure',
            'url' => env('MERCURE_URL'),
            'public_url' => env('MERCURE_PUBLIC_URL'),
            'secret' => env('MERCURE_JWT_SECRET'),
            'encryption_key' => env('MERCURE_ENCRYPTION_KEY'),
            'claims' => [
                'iss' => env('MERCURE_JWT_ISSUER'),
                'client_id' => env('APP_NAME'),
            ],
            'cookie_name' => env('MERCURE_COOKIE_NAME'),
            'subscribe_expiration' => (int) env('MERCURE_SUBSCRIBE_EXPIRATION', 5),
        ],

        'log' => [
            'driver' => 'log',
        ],

        'null' => [
            'driver' => 'null',
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Chat realtime (App\Domain\Chat\Realtime)
    |--------------------------------------------------------------------------
    |
    | queue: the queue the non-immediate broadcasts (everything except message.created, chat.claimed, session.revoked and
    |        typing) are pushed to. null = the default queue, so `php artisan dev` / any plain worker handles them. A busy
    |        installation can set REALTIME_QUEUE=broadcasts and run `queue:work --queue=broadcasts,default`.
    | auth_rate_limits: attempts a minute of POST /api/v1/public/broadcasting/auth (named limiter `broadcasting-auth`), per
    |        visitor token and per client network.
    | tag_private_channels: sign the principal's socket tag into every PRIVATE channel subscription (`channel_data`), which is what
    |        lets the server close the sockets of a revoked staff member or visitor (docs/realtime.md "Cutting a socket off").
    |        Leave it on. Only a client library that drops `channel_data` for private channels (the subscription is then refused)
    |        needs REALTIME_TAG_PRIVATE_CHANNELS=false, and loses the cut-off for visitors and for staff sockets that do not join
    |        `presence-staff`.
    |
    */

    'realtime' => [
        'queue' => env('REALTIME_QUEUE') ?: null,
        'auth_rate_limits' => [
            'per_token' => (int) env('REALTIME_AUTH_PER_TOKEN', 30),
            'per_network' => (int) env('REALTIME_AUTH_PER_NETWORK', 120),
        ],
        'tag_private_channels' => (bool) env('REALTIME_TAG_PRIVATE_CHANNELS', true),
    ],

];
