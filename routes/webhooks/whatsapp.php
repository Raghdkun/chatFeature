<?php

use App\Http\Controllers\Webhooks\OpenWaWebhookController;
use App\Http\Middleware\Chat\ChatThrottle;
use App\Http\Middleware\WhatsApp\VerifyOpenWaSignature;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| OpenWA webhook (/webhooks/openwa/{session})
|--------------------------------------------------------------------------
| Bearer-only `widget` group (registered under the `webhooks` prefix in bootstrap/app.php): no session, no cookies, no CSRF. The only
| credential is the HMAC signature of the raw body with the session's webhook secret (`VerifyOpenWaSignature`), checked before
| anything is stored. Limiter `wa-webhook`: per client network and per session.
*/
Route::post('openwa/{session}', OpenWaWebhookController::class)
    ->whereUlid('session')
    ->middleware([ChatThrottle::class.':wa-webhook', VerifyOpenWaSignature::class])
    ->name('webhooks.openwa');
