<?php

use App\Http\Controllers\Api\V1\Management\AgentCategoryController;
use App\Http\Controllers\Api\V1\Management\AgentController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Staff / agents (management API, /api/v1) - admin only
|--------------------------------------------------------------------------
| POST /agents and the is_active / is_agent flags exist in mode 1 only (409 managed_by_auth_portal in mode 2).
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'admin'])->group(function () {
    Route::get('agents', [AgentController::class, 'index'])->name('api.agents.index');
    Route::post('agents', [AgentController::class, 'store'])->name('api.agents.store');
    Route::patch('agents/{agent}', [AgentController::class, 'update'])->whereNumber('agent')->name('api.agents.update');
    Route::patch('agents/{agent}/categories', [AgentCategoryController::class, 'update'])->whereNumber('agent')->name('api.agents.categories.update');
});
