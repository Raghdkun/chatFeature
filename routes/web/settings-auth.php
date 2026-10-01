<?php

use App\Http\Controllers\Settings\AuthSettingsController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Settings > Auth (docs/contracts/auth-pizzasys.md)
|--------------------------------------------------------------------------
| Administrators only. In mode 1 the page renders "managed by this app"; every write answers 404.
*/
Route::middleware(['auth', 'session.valid', 'chat.access', 'admin'])
    ->prefix('settings/auth')
    ->name('settings.auth.')
    ->group(function () {
        Route::get('/', [AuthSettingsController::class, 'edit'])->name('edit');

        Route::put('environments/{key}', [AuthSettingsController::class, 'updateEnvironment'])
            ->whereIn('key', ['production', 'testing'])
            ->name('environments.update');

        Route::post('environments/{key}/test', [AuthSettingsController::class, 'testEnvironment'])
            ->whereIn('key', ['production', 'testing'])
            ->middleware('throttle:auth-environment-test')
            ->name('environments.test');

        Route::post('active-environment', [AuthSettingsController::class, 'activateEnvironment'])
            ->middleware('throttle:auth-environment-activate')
            ->name('active-environment');

        Route::put('roles', [AuthSettingsController::class, 'updateRoles'])->name('roles.update');
    });
