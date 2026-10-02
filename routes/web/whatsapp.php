<?php

use App\Http\Controllers\WhatsApp\WhatsAppPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| WhatsApp pages (Inertia props: docs/rest-api.md, "WhatsApp API (P6)") - ADMINISTRATORS ONLY (decision P6-D1)
|--------------------------------------------------------------------------
| `wa.admin` asks WhatsAppPolicy: an agent gets the plain 403 page and nothing about WhatsApp. Actions go through the management API.
*/
Route::middleware(['auth', 'session.valid', 'chat.access', 'wa.admin'])->group(function () {
    Route::get('whatsapp', [WhatsAppPageController::class, 'inbox'])->name('whatsapp.inbox');
    Route::get('whatsapp/chats/{chat}', [WhatsAppPageController::class, 'show'])->whereUlid('chat')->name('whatsapp.chats.show');
    Route::get('settings/whatsapp', [WhatsAppPageController::class, 'settings'])->name('settings.whatsapp.edit');
});
