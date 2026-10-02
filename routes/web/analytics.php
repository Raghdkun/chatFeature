<?php

use App\Http\Controllers\Analytics\AnalyticsPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Analytics page (P7, docs/analytics.md)
|--------------------------------------------------------------------------
| One page for every staff member: the full dashboard for an administrator, "My performance" for an agent. The numbers are read from the
| analytics API (`routes/api/management/analytics.php`), which scopes them by role on the server.
*/
Route::middleware(['auth', 'session.valid', 'chat.access'])->group(function () {
    Route::get('analytics', [AnalyticsPageController::class, 'index'])->name('analytics.index');
});
