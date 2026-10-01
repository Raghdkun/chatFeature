<?php

use App\Support\RouteFiles;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Management API  (/api/v1)  -- dashboard + future mobile app
|--------------------------------------------------------------------------
| Sanctum: stateful cookie for the dashboard, bearer token for mobile.
| Each context adds a file in routes/api/management/. The PUBLIC visitor API
| lives in routes/api/public/ and is registered in bootstrap/app.php under the
| bearer-only `widget` middleware group (never stateful / CSRF).
*/
Route::prefix('v1')->group(function () {
    RouteFiles::require(__DIR__.'/api/management');
});
