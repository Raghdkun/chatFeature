<?php

use App\Domain\Widgets\Support\PublicWidgetFinder;
use App\Http\Controllers\Api\V1\Public\ChatAttachmentController;
use App\Http\Controllers\Api\V1\Public\ChatConversationController;
use App\Http\Controllers\Api\V1\Public\ChatMessageController;
use App\Http\Controllers\Api\V1\Public\ChatOfflineTicketController;
use App\Http\Controllers\Api\V1\Public\ChatRatingController;
use App\Http\Controllers\Api\V1\Public\ChatReceiptController;
use App\Http\Controllers\Api\V1\Public\ChatSessionController;
use App\Http\Controllers\Api\V1\Public\ChatTypingController;
use App\Http\Middleware\Chat\ChatThrottle;
use App\Http\Middleware\Chat\EnsureVisitorWidgetActive;
use App\Http\Middleware\Widgets\AuthorizeWidgetOrigin;
use App\Http\Middleware\Widgets\ShieldPublicWidgets;
use App\Http\Middleware\Widgets\ThrottlePublicNetwork;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Public chat API  (/api/v1/public/...)  -- the visitor side of P4
|--------------------------------------------------------------------------
| Bearer-only `widget` group: no session, no cookies, no CSRF.
|
| 1. Session creation is scoped to a widget and goes through the same gate as the config endpoint (unknown key -> 404, browser
|    origin check, network limits) plus its own `public-session` limiter.
| 2. Everything else carries only the visitor token (`visitor`), which is bound to one session and widget: a widget disabled or
|    deleted since answers 404, every {ulid} is checked against the session (another visitor's conversation is 404, never 403),
|    and named limiters apply (`public-message`, `public-upload`, `public-offline`).
| 3. Attachments are fetched through signed, short-lived URLs (`public.attachments.show`), no token needed.
*/
Route::prefix('widgets/{key}')
    ->where(['key' => PublicWidgetFinder::KEY_PATTERN])
    ->middleware([ShieldPublicWidgets::class, ThrottlePublicNetwork::class, AuthorizeWidgetOrigin::class, ChatThrottle::class.':public-session'])
    ->group(function () {
        Route::post('sessions', [ChatSessionController::class, 'store'])->name('api.public.sessions.store');
    });

Route::get('attachments/{attachment}', [ChatAttachmentController::class, 'show'])
    ->whereUlid('attachment')
    ->middleware(['signed', ChatThrottle::class.':public-message'])
    ->name('public.attachments.show');

Route::middleware(['visitor', EnsureVisitorWidgetActive::class])->group(function () {
    Route::delete('sessions', [ChatSessionController::class, 'destroy'])->name('api.public.sessions.destroy');

    Route::post('offline-tickets', [ChatOfflineTicketController::class, 'store'])
        ->middleware(ChatThrottle::class.':public-offline')
        ->name('api.public.offline-tickets.store');

    Route::post('conversations/{ulid}/attachments', [ChatAttachmentController::class, 'store'])
        ->whereUlid('ulid')
        ->middleware(ChatThrottle::class.':public-upload')
        ->name('api.public.attachments.store');

    Route::middleware(ChatThrottle::class.':public-message')->group(function () {
        Route::get('conversation', [ChatConversationController::class, 'show'])->name('api.public.conversation.show');
        Route::post('conversations', [ChatConversationController::class, 'store'])->name('api.public.conversations.store');

        Route::prefix('conversations/{ulid}')->whereUlid('ulid')->group(function () {
            Route::get('messages', [ChatMessageController::class, 'index'])->name('api.public.messages.index');
            Route::post('messages', [ChatMessageController::class, 'store'])->name('api.public.messages.store');
            Route::post('receipts', [ChatReceiptController::class, 'store'])->name('api.public.receipts.store');
            Route::post('typing', [ChatTypingController::class, 'store'])->name('api.public.typing.store');
            Route::post('end', [ChatConversationController::class, 'end'])->name('api.public.conversations.end');
            Route::post('cancel', [ChatConversationController::class, 'cancel'])->name('api.public.conversations.cancel');
            Route::post('rating', [ChatRatingController::class, 'store'])->name('api.public.rating.store');
            Route::post('rating/skip', [ChatRatingController::class, 'skip'])->name('api.public.rating.skip');
        });
    });
});
