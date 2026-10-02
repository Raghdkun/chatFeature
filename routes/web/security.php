<?php

use App\Http\Controllers\Security\CspReportController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Content-Security-Policy violation reports (public, no credentials)
|--------------------------------------------------------------------------
| The browser posts here without cookies or a CSRF token, so the whole `web` group is excluded (like the other public delivery routes);
| the only protection is the named limiter. See CspReportController.
*/
Route::withoutMiddleware('web')
    ->middleware('throttle:'.CspReportController::LIMITER)
    ->post('csp-report', CspReportController::class)
    ->name('csp.report');
