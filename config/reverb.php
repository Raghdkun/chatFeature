<?php

use App\Domain\Chat\Realtime\AllowedOrigins;

return [

    /*
    |--------------------------------------------------------------------------
    | Default Reverb Server
    |--------------------------------------------------------------------------
    |
    | This option controls the default server used by Reverb to handle
    | incoming messages as well as broadcasting message to all your
    | connected clients. At this time only "reverb" is supported.
    |
    */

    'default' => env('REVERB_SERVER', 'reverb'),

    /*
    |--------------------------------------------------------------------------
    | Reverb Servers
    |--------------------------------------------------------------------------
    |
    | Here you may define details for each of the supported Reverb servers.
    | Each server has its own configuration options that are defined in
    | the array below. You should ensure all the options are present.
    |
    | Two different addresses are involved, and behind Caddy they differ:
    |   - the PUBLIC one clients connect to: REVERB_HOST / REVERB_PORT / REVERB_SCHEME (wss://chat.example.com:443);
    |   - the one the Reverb PROCESS binds to: REVERB_SERVER_HOST / REVERB_SERVER_PORT (0.0.0.0:8080 in the Docker service).
    | The application publishes events to the internal one (REVERB_PUBLISH_*, see config/broadcasting.php).
    |
    */

    'servers' => [

        'reverb' => [
            // Loopback by default; the Docker `reverb` service sets REVERB_SERVER_HOST=0.0.0.0.
            'host' => env('REVERB_SERVER_HOST', '127.0.0.1'),
            'port' => env('REVERB_SERVER_PORT', 8080),
            'path' => env('REVERB_SERVER_PATH', ''),
            'hostname' => env('REVERB_HOST'),
            'options' => [
                'tls' => [],
            ],
            // Largest HTTP publish body Reverb accepts. A message of `chat.max_message_length` (up to 20 000) characters is JSON
            // escaped twice (\uXXXX per non-ASCII character), so Reverb's default of 10 000 bytes would reject long messages:
            // keep it above 20 000 * 7 + overhead (pinned by tests/Feature/Realtime/RealtimeConfigTest).
            'max_request_size' => (int) env('REVERB_MAX_REQUEST_SIZE', 262_144),
            'scaling' => [
                'enabled' => (bool) env('REVERB_SCALING_ENABLED', false),
                'channel' => env('REVERB_SCALING_CHANNEL', 'reverb'),
                'server' => [
                    'url' => env('REDIS_URL'),
                    'host' => env('REDIS_HOST', '127.0.0.1'),
                    'port' => env('REDIS_PORT', '6379'),
                    'username' => env('REDIS_USERNAME'),
                    'password' => env('REDIS_PASSWORD'),
                    'database' => env('REDIS_DB', '0'),
                    'timeout' => env('REDIS_TIMEOUT', 60),
                ],
            ],
            'pulse_ingest_interval' => env('REVERB_PULSE_INGEST_INTERVAL', 15),
            'telescope_ingest_interval' => env('REVERB_TELESCOPE_INGEST_INTERVAL', 15),
        ],

    ],

    /*
    |--------------------------------------------------------------------------
    | Reverb Applications
    |--------------------------------------------------------------------------
    |
    | Here you may define how Reverb applications are managed. If you choose
    | to use the "config" provider, you may define an array of apps which
    | your server will support, including their connection credentials.
    |
    */

    'apps' => [

        'provider' => 'config',

        'apps' => [
            [
                'key' => env('REVERB_APP_KEY'),
                'secret' => env('REVERB_APP_SECRET'),
                'app_id' => env('REVERB_APP_ID'),
                // The CLIENT-facing address (what the dashboard and the visitor panel connect to, see ReverbEndpoint).
                'options' => [
                    'host' => env('REVERB_HOST'),
                    'port' => env('REVERB_PORT', 443),
                    'scheme' => env('REVERB_SCHEME', 'https'),
                    'useTLS' => env('REVERB_SCHEME', 'https') === 'https',
                ],
                // Host names a browser may open a socket from: the app's own host (the dashboard AND the visitor panel iframe both
                // live on it) plus REVERB_ALLOWED_ORIGINS (comma separated). Never `*`. The host saved by the setup wizard is
                // added when `reverb:start` boots (RealtimeServiceProvider).
                'allowed_origins' => AllowedOrigins::forApp(env('APP_URL'), env('REVERB_ALLOWED_ORIGINS'), env('APP_ENV') === 'local'),
                'ping_interval' => (int) env('REVERB_APP_PING_INTERVAL', 60),
                'activity_timeout' => (int) env('REVERB_APP_ACTIVITY_TIMEOUT', 30),
                'max_connections' => env('REVERB_APP_MAX_CONNECTIONS'),
                // Largest message a CLIENT may send (typing whispers are a few dozen bytes; chat messages travel over REST).
                'max_message_size' => (int) env('REVERB_APP_MAX_MESSAGE_SIZE', 10_000),
                // Whispers are accepted from subscribed (authorised) connections only.
                'accept_client_events_from' => env('REVERB_APP_ACCEPT_CLIENT_EVENTS_FROM', 'members'),
                // Per connection and every incoming frame (pings, subscribes, whispers): a typing indicator every 3 s is about 20 a minute.
                'rate_limiting' => [
                    'enabled' => (bool) env('REVERB_APP_RATE_LIMITING_ENABLED', true),
                    'max_attempts' => (int) env('REVERB_APP_RATE_LIMIT_MAX_ATTEMPTS', 120),
                    'decay_seconds' => (int) env('REVERB_APP_RATE_LIMIT_DECAY_SECONDS', 60),
                    'terminate_on_limit' => (bool) env('REVERB_APP_RATE_LIMIT_TERMINATE', false),
                ],
            ],
        ],

    ],

];
