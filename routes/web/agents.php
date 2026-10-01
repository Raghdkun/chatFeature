<?php

use App\Http\Controllers\Agents\AgentPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Agents page (admin only)
|--------------------------------------------------------------------------
*/
Route::middleware(['auth', 'session.valid', 'chat.access', 'admin'])->group(function () {
    Route::get('agents', [AgentPageController::class, 'index'])->name('agents.index');
});
