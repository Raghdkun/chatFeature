<?php

use App\Http\Controllers\Setup\SetupController;
use App\Http\Middleware\EnsureNotInstalled;
use App\Http\Middleware\EnsureSetupTokenVerified;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Setup wizard (docs/contracts/setup-wizard.md)
|--------------------------------------------------------------------------
| Guest-only and pre-install: every URL below is 404 once installed.lock exists.
| No database is touched before the `run-migrations` step succeeds.
*/
Route::prefix('setup')
    ->name('setup.')
    ->middleware(EnsureNotInstalled::class)
    ->group(function () {
        Route::get('/', [SetupController::class, 'index'])->name('index');

        Route::post('token', [SetupController::class, 'token'])
            ->middleware('throttle:5,1,setup-token')
            ->name('token');

        Route::middleware(EnsureSetupTokenVerified::class)->group(function () {
            Route::get('state', [SetupController::class, 'state'])->name('state');
            Route::post('mode', [SetupController::class, 'mode'])->name('mode');
            Route::post('admin', [SetupController::class, 'admin'])->name('admin');
            Route::post('basics', [SetupController::class, 'basics'])->name('basics');

            // Mode 2 (pizzasys): portal environments, connection test and the verified portal administrator.
            Route::post('pizzasys', [SetupController::class, 'pizzasys'])->middleware('throttle:setup-portal-save')->name('pizzasys');
            Route::post('pizzasys/test', [SetupController::class, 'testPizzasys'])->middleware('throttle:setup-portal-test')->name('pizzasys.test');
            Route::post('portal-admin', [SetupController::class, 'portalAdmin'])->middleware('throttle:setup-portal-admin')->name('portal-admin');
            Route::post('run/{step}', [SetupController::class, 'run'])
                ->where('step', '[a-z\-]+')
                ->middleware('throttle:60,1,setup-run')
                ->name('run');
        });
    });
