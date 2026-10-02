<?php

use App\Http\Controllers\Api\V1\Management\NotificationSettingsController;
use App\Http\Controllers\Api\V1\Management\PushDeviceController;
use App\Http\Controllers\Api\V1\Management\PushSubscriptionController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Notifications: preferences, web push subscriptions, devices (management API, /api/v1)
|--------------------------------------------------------------------------
| Any staff member (admin and/or agent), only ever their own rows: there is no user id in these URLs, and a subscription / device id of
| somebody else is a 404. Limiter `staff-api` (per user) on all of it, `push-subscriptions` on registering and removing, `push-test`
| on the test push (a real push to the push services). Decisions P5-D4 and P5-D9.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', ChatThrottle::class.':staff-api'])->group(function () {
    Route::get('me/notification-settings', [NotificationSettingsController::class, 'show'])->name('api.me.notification-settings.show');
    Route::put('me/notification-settings', [NotificationSettingsController::class, 'update'])->name('api.me.notification-settings.update');

    Route::get('me/push-subscriptions', [PushSubscriptionController::class, 'index'])->name('api.me.push-subscriptions.index');
    Route::post('me/push-subscriptions/test', [PushSubscriptionController::class, 'test'])
        ->middleware(ChatThrottle::class.':push-test')
        ->name('api.me.push-subscriptions.test');

    Route::middleware(ChatThrottle::class.':push-subscriptions')->group(function () {
        Route::post('me/push-subscriptions', [PushSubscriptionController::class, 'store'])->name('api.me.push-subscriptions.store');
        Route::delete('me/push-subscriptions/{subscription}', [PushSubscriptionController::class, 'destroy'])->whereUlid('subscription')->name('api.me.push-subscriptions.destroy');

        Route::post('me/devices', [PushDeviceController::class, 'store'])->name('api.me.devices.store');
        Route::delete('me/devices/{device}', [PushDeviceController::class, 'destroy'])->whereUlid('device')->name('api.me.devices.destroy');
    });
});
