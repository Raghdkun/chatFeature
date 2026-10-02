<?php

use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Api\V1\Public\WhatsAppHandoffController;
use App\Http\Middleware\Chat\ChatThrottle;
use App\Http\Middleware\Chat\EnsureVisitorWidgetActive;
use App\Http\Middleware\Widgets\AuthorizeWidgetOrigin;
use App\Http\Middleware\Widgets\ShieldPublicWidgets;
use App\Http\Middleware\Widgets\ThrottlePublicNetwork;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| WhatsApp hand-off (public API, /api/v1/public/widgets/{key}/whatsapp-handoff)
|--------------------------------------------------------------------------
| Bearer-only `widget` group. The same gates as starting a chat, in the same order: the widget gate (unknown / disabled key 404, browser
| Origin check, network limits), the network limit in front of the token lookup, the visitor token (`vt_...`, bound to one widget; `{key}` must
| be that widget), then the hand-off's own limiter `wa-handoff` (per visitor, per network, per widget + network, per widget).
*/
Route::prefix('widgets/{key}')
    ->where(['key' => PublicWidgetFinder::KEY_PATTERN])
    ->middleware([
        ShieldPublicWidgets::class,
        ThrottlePublicNetwork::class,
        AuthorizeWidgetOrigin::class,
        ChatThrottle::class.':public-network',
        'visitor',
        EnsureVisitorWidgetActive::class,
        ChatThrottle::class.':wa-handoff',
    ])
    ->group(function () {
        Route::post('whatsapp-handoff', [WhatsAppHandoffController::class, 'store'])->name('api.public.whatsapp.handoff');
    });
