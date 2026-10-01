<?php

use App\Http\Controllers\Catalog\CategoryPageController;
use App\Http\Controllers\Catalog\SupportCategoriesPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Category pages
|--------------------------------------------------------------------------
| /categories is admin-only; /settings/support-categories is for every staff member (agents pick what they serve).
*/
Route::middleware(['auth', 'session.valid', 'chat.access'])->group(function () {
    Route::get('settings/support-categories', [SupportCategoriesPageController::class, 'edit'])->name('settings.support-categories');

    Route::middleware('admin')->group(function () {
        Route::get('categories', [CategoryPageController::class, 'index'])->name('categories.index');
    });
});
