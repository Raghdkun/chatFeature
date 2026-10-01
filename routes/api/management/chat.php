<?php

use App\Http\Controllers\Api\V1\Management\ChatClaimController;
use App\Http\Controllers\Api\V1\Management\ChatExportController;
use App\Http\Controllers\Api\V1\Management\ChatLifecycleController;
use App\Http\Controllers\Api\V1\Management\ChatPresenceController;
use App\Http\Controllers\Api\V1\Management\ChatStaffAttachmentController;
use App\Http\Controllers\Api\V1\Management\ChatStaffConversationController;
use App\Http\Controllers\Api\V1\Management\ChatStaffMessageController;
use App\Http\Controllers\Api\V1\Management\ChatStaffReceiptController;
use App\Http\Controllers\Api\V1\Management\ChatStaffTypingController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Conversations and presence (management API, /api/v1)
|--------------------------------------------------------------------------
| Sanctum cookie for the dashboard or bearer for mobile. Visibility is `Conversation::visibleTo` (list) and `ConversationPolicy`
| (single conversations, called explicitly by the actions: `Gate::before` would let an admin through every state check).
| The export is admin only. Limiter `staff-api`: per staff member.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', ChatThrottle::class.':staff-api'])->group(function () {
    Route::get('conversations', [ChatStaffConversationController::class, 'index'])->name('api.conversations.index');
    Route::get('conversations/queue', [ChatStaffConversationController::class, 'queue'])->name('api.conversations.queue');
    Route::get('conversations/export', [ChatExportController::class, 'index'])->middleware('admin')->name('api.conversations.export');

    Route::prefix('conversations/{conversation}')->whereUlid('conversation')->group(function () {
        Route::get('/', [ChatStaffConversationController::class, 'show'])->name('api.conversations.show');
        Route::get('messages', [ChatStaffMessageController::class, 'index'])->name('api.conversations.messages.index');
        Route::post('messages', [ChatStaffMessageController::class, 'store'])->name('api.conversations.messages.store');
        Route::post('claim', [ChatClaimController::class, 'store'])->name('api.conversations.claim');
        Route::post('attachments', [ChatStaffAttachmentController::class, 'store'])->name('api.conversations.attachments.store');
        Route::post('receipts', [ChatStaffReceiptController::class, 'store'])->name('api.conversations.receipts.store');
        Route::post('typing', [ChatStaffTypingController::class, 'store'])->name('api.conversations.typing.store');
        Route::post('end', [ChatLifecycleController::class, 'end'])->name('api.conversations.end');
        Route::post('close', [ChatLifecycleController::class, 'close'])->name('api.conversations.close');
        Route::post('transfer', [ChatLifecycleController::class, 'transfer'])->name('api.conversations.transfer');
    });

    Route::get('me/presence', [ChatPresenceController::class, 'show'])->name('api.me.presence.show');
    Route::put('me/presence', [ChatPresenceController::class, 'update'])->name('api.me.presence.update');
    Route::post('me/presence/heartbeat', [ChatPresenceController::class, 'heartbeat'])->name('api.me.presence.heartbeat');
});
