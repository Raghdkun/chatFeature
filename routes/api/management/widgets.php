<?php

use App\Http\Controllers\Api\V1\Management\WidgetCategoryController;
use App\Http\Controllers\Api\V1\Management\WidgetController;
use App\Http\Controllers\Api\V1\Management\WidgetDomainController;
use App\Http\Controllers\Api\V1\Management\WidgetDraftController;
use App\Http\Controllers\Api\V1\Management\WidgetGreetingController;
use App\Http\Controllers\Api\V1\Management\WidgetPublishController;
use App\Http\Controllers\Api\V1\Management\WidgetSecretController;
use App\Http\Controllers\Api\V1\Management\WidgetSnippetController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Widgets (management API, /api/v1) - admin only
|--------------------------------------------------------------------------
| No response ever carries the identity secret except POST .../rotate-secret (once).
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'admin'])->group(function () {
    Route::get('widgets', [WidgetController::class, 'index'])->name('api.widgets.index');
    Route::post('widgets', [WidgetController::class, 'store'])->name('api.widgets.store');
    Route::get('widgets/{widget}', [WidgetController::class, 'show'])->name('api.widgets.show');
    Route::patch('widgets/{widget}', [WidgetController::class, 'update'])->name('api.widgets.update');
    Route::delete('widgets/{widget}', [WidgetController::class, 'destroy'])->name('api.widgets.destroy');

    Route::put('widgets/{widget}/draft', [WidgetDraftController::class, 'update'])->name('api.widgets.draft');
    Route::post('widgets/{widget}/publish', [WidgetPublishController::class, 'store'])->name('api.widgets.publish');
    Route::put('widgets/{widget}/domains', [WidgetDomainController::class, 'update'])->name('api.widgets.domains');
    Route::put('widgets/{widget}/greetings', [WidgetGreetingController::class, 'update'])->name('api.widgets.greetings');
    Route::put('widgets/{widget}/categories', [WidgetCategoryController::class, 'update'])->name('api.widgets.categories');
    Route::post('widgets/{widget}/rotate-secret', [WidgetSecretController::class, 'store'])->name('api.widgets.rotate-secret');
    Route::get('widgets/{widget}/snippet', [WidgetSnippetController::class, 'show'])->name('api.widgets.snippet');
});
