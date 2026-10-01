<?php

use App\Http\Controllers\Widgets\WidgetPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Widget dashboard pages (admin only; Inertia props: docs/contracts/dashboard-pages-p3.md)
|--------------------------------------------------------------------------
*/
Route::middleware(['auth', 'session.valid', 'chat.access', 'admin'])->group(function () {
    Route::get('widgets', [WidgetPageController::class, 'index'])->name('widgets.index');
    Route::get('widgets/{widget}', [WidgetPageController::class, 'show'])->name('widgets.show');
});
