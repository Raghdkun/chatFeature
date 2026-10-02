<?php

use App\Http\Controllers\Notifications\ManifestController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Web app manifest (P5-D6)
|--------------------------------------------------------------------------
| Generated from the settings (the app name cannot live in a static file). Public like the icons next to it: a browser fetches the
| manifest without credentials, so it runs without the `web` group (no session, no cookie) like the widget delivery routes.
*/
Route::withoutMiddleware('web')->get('manifest.webmanifest', ManifestController::class)->name('manifest');

/*
| Settings > Notifications: the preferences, the registered browsers, the permission help (the page itself calls the API of
| routes/api/management/notifications.php). Staff only, like the rest of the settings: `EnsureChatAccess` is in the web group.
*/
Route::middleware(['auth'])->group(function () {
    Route::inertia('settings/notifications', 'settings/notifications')->name('notifications.edit');
});
