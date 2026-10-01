<?php

/*
|--------------------------------------------------------------------------
| Cross-Origin Resource Sharing
|--------------------------------------------------------------------------
|
| Laravel's global HandleCors middleware would otherwise answer every `api/*` request with
| `Access-Control-Allow-Origin: *` and short-circuit preflights, which would defeat the per-widget domain
| whitelist. CORS is therefore OFF globally: the dashboard talks to the API same-origin (session cookie) and the
| mobile app is not a browser. The public widget endpoints implement their own echo-the-allowed-origin policy
| (App\Http\Middleware\Widgets\AuthorizeWidgetOrigin).
|
*/

return [

    'paths' => [],

    'allowed_methods' => ['*'],

    'allowed_origins' => [],

    'allowed_origins_patterns' => [],

    'allowed_headers' => ['*'],

    'exposed_headers' => [],

    'max_age' => 0,

    'supports_credentials' => false,

];
