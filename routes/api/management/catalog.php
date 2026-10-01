<?php

use App\Http\Controllers\Api\V1\Management\CategoryController;
use App\Http\Controllers\Api\V1\Management\MeCategoryController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Categories (management API, /api/v1)
|--------------------------------------------------------------------------
| Listing and the caller's own selection are open to every staff member; writes are admin-only.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access'])->group(function () {
    Route::get('categories', [CategoryController::class, 'index'])->name('api.categories.index');
    Route::get('me/categories', [MeCategoryController::class, 'show'])->name('api.me.categories.show');
    Route::put('me/categories', [MeCategoryController::class, 'update'])->name('api.me.categories.update');

    Route::middleware('admin')->group(function () {
        Route::post('categories', [CategoryController::class, 'store'])->name('api.categories.store');
        Route::get('categories/{category}', [CategoryController::class, 'show'])->name('api.categories.show');
        Route::patch('categories/{category}', [CategoryController::class, 'update'])->name('api.categories.update');
        Route::delete('categories/{category}', [CategoryController::class, 'destroy'])->name('api.categories.destroy');
    });
});
