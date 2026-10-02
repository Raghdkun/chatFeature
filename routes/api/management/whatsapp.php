<?php

use App\Http\Controllers\Api\V1\Management\WhatsAppChatController;
use App\Http\Controllers\Api\V1\Management\WhatsAppExportController;
use App\Http\Controllers\Api\V1\Management\WhatsAppMediaController;
use App\Http\Controllers\Api\V1\Management\WhatsAppMessageController;
use App\Http\Controllers\Api\V1\Management\WhatsAppSessionControlController;
use App\Http\Controllers\Api\V1\Management\WhatsAppSessionController;
use App\Http\Controllers\Api\V1\Management\WhatsAppSettingsController;
use App\Http\Controllers\Api\V1\Management\WidgetWhatsAppController;
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
        Route::post('webhook', [WhatsAppSessionControlController::class, 'webhook'])->name('api.whatsapp.sessions.webhook');
        Route::get('qr', [WhatsAppSessionControlController::class, 'qr'])->middleware(ChatThrottle::class.':wa-qr')->name('api.whatsapp.sessions.qr');
    });

    Route::get('settings', [WhatsAppSettingsController::class, 'show'])->name('api.whatsapp.settings.show');
    Route::put('settings', [WhatsAppSettingsController::class, 'update'])->name('api.whatsapp.settings.update');
    Route::post('settings/test', [WhatsAppSettingsController::class, 'test'])->middleware(ChatThrottle::class.':wa-test')->name('api.whatsapp.settings.test');

    Route::get('chats', [WhatsAppChatController::class, 'index'])->name('api.whatsapp.chats.index');

    Route::prefix('chats/{chat}')->whereUlid('chat')->group(function () {
        Route::get('/', [WhatsAppChatController::class, 'show'])->name('api.whatsapp.chats.show');
        Route::get('messages', [WhatsAppMessageController::class, 'index'])->name('api.whatsapp.chats.messages.index');
        Route::post('messages', [WhatsAppMessageController::class, 'store'])->name('api.whatsapp.chats.messages.store');
        Route::post('read', [WhatsAppChatController::class, 'read'])->name('api.whatsapp.chats.read');
        Route::post('archive', [WhatsAppChatController::class, 'archive'])->name('api.whatsapp.chats.archive');
        Route::post('unarchive', [WhatsAppChatController::class, 'unarchive'])->name('api.whatsapp.chats.unarchive');
        Route::delete('/', [WhatsAppChatController::class, 'destroy'])->name('api.whatsapp.chats.destroy');
    });

    Route::get('export', [WhatsAppExportController::class, 'index'])->name('api.whatsapp.export');

    // The target of the signed URLs in `WaMediaData`: the signature AND an administrator's session (an `<img>` carries the cookie).
    Route::get('media/{message}', [WhatsAppMediaController::class, 'show'])->whereUlid('message')->middleware('signed')->name('whatsapp.media.show');
});

// Which WhatsApp number a widget hands visitors over to (the widget belongs to /widgets, the permission to WhatsApp: administrators only).
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', 'wa.admin', ChatThrottle::class.':staff-api'])->group(function () {
    Route::get('widgets/{widget}/whatsapp', [WidgetWhatsAppController::class, 'show'])->name('api.widgets.whatsapp.show');
    Route::put('widgets/{widget}/whatsapp', [WidgetWhatsAppController::class, 'update'])->name('api.widgets.whatsapp.update');
});
