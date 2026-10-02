<?php

use App\Http\Controllers\Api\V1\Management\WhatsAppSessionControlController;
use App\Http\Controllers\Api\V1\Management\WhatsAppSessionController;
use App\Http\Controllers\Api\V1\Management\WhatsAppSettingsController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| WhatsApp (management API, /api/v1) - ADMINISTRATORS ONLY (decision P6-D1)
|--------------------------------------------------------------------------
| `wa.admin` asks WhatsAppPolicy: an agent, an account without a chat role, a deactivated administrator, a guest and a visitor token are all
| turned away (the actions ask the policy again). Limiter `staff-api`: per staff member; the QR poll and the connection test have their own.
| docs/rest-api.md, "WhatsApp API (P6)".
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'wa.admin', ChatThrottle::class.':staff-api'])->prefix('whatsapp')->group(function () {
    Route::get('sessions', [WhatsAppSessionController::class, 'index'])->name('api.whatsapp.sessions.index');
    Route::post('sessions', [WhatsAppSessionController::class, 'store'])->name('api.whatsapp.sessions.store');

    Route::prefix('sessions/{session}')->whereUlid('session')->group(function () {
        Route::get('/', [WhatsAppSessionController::class, 'show'])->name('api.whatsapp.sessions.show');
        Route::patch('/', [WhatsAppSessionController::class, 'update'])->name('api.whatsapp.sessions.update');
        Route::delete('/', [WhatsAppSessionController::class, 'destroy'])->name('api.whatsapp.sessions.destroy');
        Route::post('start', [WhatsAppSessionControlController::class, 'start'])->name('api.whatsapp.sessions.start');
        Route::post('stop', [WhatsAppSessionControlController::class, 'stop'])->name('api.whatsapp.sessions.stop');
        Route::post('sync', [WhatsAppSessionControlController::class, 'sync'])->name('api.whatsapp.sessions.sync');
        Route::get('qr', [WhatsAppSessionControlController::class, 'qr'])->middleware(ChatThrottle::class.':wa-qr')->name('api.whatsapp.sessions.qr');
    });

    Route::get('settings', [WhatsAppSettingsController::class, 'show'])->name('api.whatsapp.settings.show');
    Route::put('settings', [WhatsAppSettingsController::class, 'update'])->name('api.whatsapp.settings.update');
    Route::post('settings/test', [WhatsAppSettingsController::class, 'test'])->middleware(ChatThrottle::class.':wa-test')->name('api.whatsapp.settings.test');
});
