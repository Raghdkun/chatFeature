<?php

use App\Http\Controllers\Api\V1\Management\StaffAuthController;
use App\Http\Middleware\Chat\ChatThrottle;
use Illuminate\Support\Facades\Route;

/*
|--------------------------------------------------------------------------
| Own credential and tokens (management API, /api/v1/auth)
|--------------------------------------------------------------------------
| For any signed-in staff member (dashboard cookie or mobile bearer), only ever about themselves: `auth/me` says who and which driver,
| `auth/tokens` lists the caller's own bearer tokens (one per signed-in device), `DELETE auth/tokens/{id}` revokes one of them (anyone
| else's is a 404) and `POST auth/logout` revokes the token the call was made with. There is deliberately no login route here (see
| docs/mobile-readiness.md). Limiter `staff-api`.
*/
Route::middleware(['auth:sanctum', 'session.valid', 'chat.access', ChatThrottle::class.':staff-api'])->prefix('auth')->group(function () {
    Route::get('me', [StaffAuthController::class, 'me'])->name('api.auth.me');
    Route::get('tokens', [StaffAuthController::class, 'tokens'])->name('api.auth.tokens.index');
    Route::delete('tokens/{token}', [StaffAuthController::class, 'revoke'])->whereNumber('token')->name('api.auth.tokens.destroy');
    Route::post('logout', [StaffAuthController::class, 'logout'])->name('api.auth.logout');
});
