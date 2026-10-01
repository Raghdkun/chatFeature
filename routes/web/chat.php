<?php

use App\Http\Controllers\Dashboard\HistoryPageController;
use App\Http\Controllers\Dashboard\InboxPageController;
use App\Http\Controllers\Dashboard\OfflineTicketsPageController;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Staff chat pages (Inertia props: docs/contracts/chat-ui-p4.md)
|--------------------------------------------------------------------------
| Inbox and offline tickets are for every staff member (the lists are scoped with Conversation::visibleTo()); the history of all
| conversations is admin only. Actions (claim, send, end, transfer, ...) go through the management API, not these routes.
*/
Route::middleware(['auth', 'session.valid', 'chat.access'])->group(function () {
    Route::get('inbox', [InboxPageController::class, 'index'])->name('inbox.index');
    Route::get('inbox/{conversation}', [InboxPageController::class, 'show'])->name('inbox.show');
    Route::get('offline-tickets', [OfflineTicketsPageController::class, 'index'])->name('offline-tickets.index');

    Route::middleware('admin')->group(function () {
        Route::get('history', [HistoryPageController::class, 'index'])->name('history.index');
    });
});
