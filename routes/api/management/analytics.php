<?php

use App\Http\Controllers\Api\V1\Management\AnalyticsController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Analytics (management API, /api/v1/analytics)
|--------------------------------------------------------------------------
| Sanctum cookie for the dashboard or bearer for mobile, like every staff endpoint. Every staff member may read `overview`, `timeseries`,
| `heatmap` and `ratings`, but the SERVER scopes them: an agent only ever gets their own numbers (AnalyticsQueryFactory). `breakdown`,
| `whatsapp` and `export` are administrator-only. Limiter `staff-api`: per staff member.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', ChatThrottle::class.':staff-api'])->prefix('analytics')->group(function () {
    Route::get('overview', [AnalyticsController::class, 'overview'])->name('api.analytics.overview');
    Route::get('timeseries', [AnalyticsController::class, 'timeseries'])->name('api.analytics.timeseries');
    Route::get('heatmap', [AnalyticsController::class, 'heatmap'])->name('api.analytics.heatmap');
    Route::get('ratings', [AnalyticsController::class, 'ratings'])->name('api.analytics.ratings');

    Route::middleware('admin')->group(function () {
        Route::get('breakdown', [AnalyticsController::class, 'breakdown'])->name('api.analytics.breakdown');
        Route::get('whatsapp', [AnalyticsController::class, 'whatsapp'])->name('api.analytics.whatsapp');
        Route::get('export', [AnalyticsController::class, 'export'])->name('api.analytics.export');
    });
});
