<?php

use App\Http\Controllers\Dashboard\WhatsAppInboxPageController;
use App\Http\Controllers\Dashboard\WhatsAppSettingsPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| WhatsApp pages (decision P6-D1: administrators only, an agent gets 403)
|--------------------------------------------------------------------------
| The inbox (one page, `selected` is the open chat) and the settings page. `wa.admin` asks the WhatsAppPolicy (an active administrator); the
| controllers ask it again. Everything the pages do after the first paint goes through the management API
| (routes/api/management/whatsapp.php) and the private-whatsapp-admin channel.
*/
Route::middleware(['auth', 'session.valid', 'chat.access', 'wa.admin'])->group(function () {
    Route::get('whatsapp', [WhatsAppInboxPageController::class, 'index'])->name('whatsapp.inbox');
    Route::get('whatsapp/chats/{chat}', [WhatsAppInboxPageController::class, 'show'])->whereUlid('chat')->name('whatsapp.chats.show');
    Route::get('whatsapp/{chat}', [WhatsAppInboxPageController::class, 'legacy'])->whereUlid('chat')->name('whatsapp.show');
    Route::get('settings/whatsapp', [WhatsAppSettingsPageController::class, 'edit'])->name('settings.whatsapp.edit');
});
