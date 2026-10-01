<?php

use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Embed\EmbedController;
use App\Http\Controllers\Embed\LoaderController;
use App\Http\Middleware\Widgets\ResolveEmbedPreview;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Widget delivery (public): loader script, iframe page, hosted page
|--------------------------------------------------------------------------
| These are loaded under the `web` group by routes/web.php, but they must never start a session or set a cookie
| (visitors have none; the host page's cookies are not ours to touch), so the whole `web` group is excluded.
| GET /embed/{key}?preview=1 is the one exception: ResolveEmbedPreview reads the admin session without setting cookies.
*/
Route::withoutMiddleware('web')
    ->middleware('throttle:public-config')
    ->where(['key' => PublicWidgetFinder::KEY_PATTERN])
    ->group(function () {
        Route::get('w/{key}.js', [LoaderController::class, 'widget'])->name('embed.script');
        Route::get('embed/{key}', [EmbedController::class, 'embed'])->middleware(ResolveEmbedPreview::class)->name('embed.frame');
        Route::get('c/{key}', [EmbedController::class, 'hosted'])->name('embed.hosted');
    });

Route::withoutMiddleware('web')->get('widget/v1/loader.js', [LoaderController::class, 'generic'])->name('embed.loader');
