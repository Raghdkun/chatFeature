<?php

use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Api\V1\Public\WidgetAvailabilityController;
use App\Http\Controllers\Api\V1\Public\WidgetConfigController;
use App\Http\Middleware\Widgets\AuthorizeWidgetOrigin;
use App\Http\Middleware\Widgets\ShieldPublicWidgets;
use App\Http\Middleware\Widgets\ThrottlePublicNetwork;
use App\Http\Middleware\Widgets\ThrottlePublicWidget;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Public widget API  (/api/v1/public/widgets/{key}/...)
|--------------------------------------------------------------------------
| Bearer-only `widget` group: no session, no cookies, no CSRF. Unknown keys 404, non-whitelisted browser origins 403,
| allowed origins are echoed in `Access-Control-Allow-Origin`. OPTIONS preflights are answered by the middleware.
|
| Order matters: ShieldPublicWidgets (unknown-key probing, CORS on 429) -> ThrottlePublicNetwork (per client network, before
| the key is looked up) -> AuthorizeWidgetOrigin (404 / 403 / preflight) -> ThrottlePublicWidget (per widget and origin;
| only allowed callers count).
*/
Route::prefix('widgets/{key}')
    ->where(['key' => PublicWidgetFinder::KEY_PATTERN])
    ->middleware([ShieldPublicWidgets::class, ThrottlePublicNetwork::class, AuthorizeWidgetOrigin::class, ThrottlePublicWidget::class])
    ->group(function () {
        Route::match(['GET', 'OPTIONS'], 'config', [WidgetConfigController::class, 'show'])->name('api.public.widgets.config');
        Route::match(['GET', 'OPTIONS'], 'availability', [WidgetAvailabilityController::class, 'show'])->name('api.public.widgets.availability');
    });
