<?php

use App\Http\Controllers\Api\V1\Management\PrivacyRetentionController;
use App\Http\Controllers\Api\V1\Management\PrivacyVisitorController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Privacy: data-subject requests and retention (management API, /api/v1, P7)
|--------------------------------------------------------------------------
| Administrators only (`admin` after the session checks), limiter `staff-api`. Every call is audited with ids and counts, never the
| content. See docs/security.md, "Data retention and erasure".
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'admin', ChatThrottle::class.':staff-api'])->group(function () {
    Route::get('visitors/{ulid}/export', [PrivacyVisitorController::class, 'export'])->name('api.visitors.export');
    Route::delete('visitors/{ulid}', [PrivacyVisitorController::class, 'destroy'])->name('api.visitors.destroy');
    Route::get('privacy/retention', [PrivacyRetentionController::class, 'show'])->name('api.privacy.retention.show');
    Route::put('privacy/retention', [PrivacyRetentionController::class, 'update'])->name('api.privacy.retention.update');
});
